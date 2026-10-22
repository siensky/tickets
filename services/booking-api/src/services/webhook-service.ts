/**
 * Stripes webhook (docs/plan.md "Betalning" / "Webhook-hantering"):
 * verifiera signatur → dedupe på händelse-id → skriv till outbox → klar.
 * Skapar ALDRIG ordern/biljetterna här — det gör
 * payment-consumer-service.ts, asynkront, efter att detta har svarat
 * 200. "Körs ordertransaktionen synkront timeout:ar Stripe och
 * retryar, vilket multiplicerar lasten precis när systemet minst tål
 * det" (docs/plan.md).
 */
import { getPoolForEvent, withTransaction, type ShardPools } from '@tickets/db';
import {
  InternalError,
  OUTBOX_EVENT_TYPES,
  UnauthorizedError,
  type PaymentSucceededPayload,
} from '@tickets/domain';
import type { PoolClient } from 'pg';
import type Stripe from 'stripe';
import { getPaymentByProviderRef } from '../repositories/payments-repository.js';
import { claimProcessedMessage } from '../repositories/processed-messages-repository.js';
import { insertOutboxEvent } from '../repositories/outbox-repository.js';

const WEBHOOK_CONSUMER = 'stripe-webhook';

export interface WebhookServiceDeps {
  readonly shardPools: ShardPools;
  readonly stripe: Stripe;
  readonly webhookSecret: string;
}

export type WebhookResult = { readonly kind: 'processed' | 'ignored' | 'duplicate' };

function constructEventOrThrow(
  deps: WebhookServiceDeps,
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  try {
    return deps.stripe.webhooks.constructEvent(rawBody, signature, deps.webhookSecret);
  } catch (error) {
    throw new UnauthorizedError('Stripe webhook signature verification failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function readMetadata(session: Stripe.Checkout.Session): {
  orderId: string;
  reservationId: string;
} {
  const orderId = session.metadata?.['orderId'];
  const reservationId = session.metadata?.['reservationId'];
  if (orderId === undefined || reservationId === undefined) {
    throw new InternalError('Stripe Checkout Session is missing required metadata', {
      sessionId: session.id,
    });
  }
  return { orderId, reservationId };
}

/** `payment_intent` is a bare string unless the webhook subscription expands it — we never ask it to. */
function readPaymentIntentId(session: Stripe.Checkout.Session): string {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent !== 'string') {
    throw new InternalError('Stripe Checkout Session has no payment_intent id', {
      sessionId: session.id,
    });
  }
  return paymentIntent;
}

export async function handleStripeWebhook(
  deps: WebhookServiceDeps,
  rawBody: Buffer,
  signature: string,
): Promise<WebhookResult> {
  const event = constructEventOrThrow(deps, rawBody, signature);
  if (event.type !== 'checkout.session.completed') {
    return { kind: 'ignored' };
  }
  // Stripes typer narrowar redan `event.data.object` till
  // `Checkout.Session` via diskriminanten `event.type`, kontrollerad
  // ovan — ingen cast behövs.
  const session = event.data.object;
  if (session.payment_status !== 'paid') {
    return { kind: 'ignored' };
  }
  const { orderId, reservationId } = readMetadata(session);
  const eventId = session.metadata?.['eventId'];
  if (eventId === undefined) {
    throw new InternalError('Stripe Checkout Session is missing eventId metadata', {
      sessionId: session.id,
    });
  }
  const paymentIntentId = readPaymentIntentId(session);

  const pool = getPoolForEvent(deps.shardPools, eventId);
  return withTransaction(pool, (client) =>
    recordPaymentSucceeded(client, {
      eventId,
      orderId,
      reservationId,
      sessionId: session.id,
      paymentIntentId,
      stripeEventId: event.id,
    }),
  );
}

async function recordPaymentSucceeded(
  client: PoolClient,
  params: {
    eventId: string;
    orderId: string;
    reservationId: string;
    sessionId: string;
    paymentIntentId: string;
    stripeEventId: string;
  },
): Promise<WebhookResult> {
  const claimed = await claimProcessedMessage(client, {
    eventId: params.eventId,
    messageId: params.stripeEventId,
    consumer: WEBHOOK_CONSUMER,
  });
  if (!claimed) {
    return { kind: 'duplicate' };
  }

  const payment = await getPaymentByProviderRef(client, params.eventId, params.sessionId);
  if (payment === undefined) {
    throw new InternalError('No payment row found for this Checkout Session', {
      sessionId: params.sessionId,
      eventId: params.eventId,
    });
  }

  const payload: PaymentSucceededPayload = {
    paymentId: payment.id,
    orderId: params.orderId,
    reservationId: params.reservationId,
    eventId: params.eventId,
    providerRef: params.sessionId,
    providerChargeRef: params.paymentIntentId,
  };
  await insertOutboxEvent(client, {
    eventId: params.eventId,
    type: OUTBOX_EVENT_TYPES.PAYMENT_SUCCEEDED,
    payload,
  });
  return { kind: 'processed' };
}
