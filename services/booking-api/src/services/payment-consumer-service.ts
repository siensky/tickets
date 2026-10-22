/**
 * Konsumerar `payment.succeeded` (docs/plan.md "Betalning"): konverterar
 * reservationen och myntar biljetter — ELLER, om frysningen redan
 * hunnit gå ut och stolarna tagits över av någon annan, återbetalar
 * automatiskt ("Betalning som landar efter utgången reservation": "Två
 * mekanismer, inte en"). Körs i booking-api, inte i notification-worker
 * eller scheduler-worker — se docs/forsvar.md för avvägningen.
 *
 * Biljettmyntning, reservationskonvertering OCH outbox-skrivningen körs
 * i SAMMA transaktion som dedupe-claimen (`processed_messages`) — annars
 * är det transaktionella outbox-mönstret poänglöst: en process som
 * kraschar MELLAN två separata transaktioner skulle kunna mynta
 * biljetter utan att någonsin skriva händelsen som får
 * notification-worker att skicka bekräftelsemejlet.
 */
import { getPoolForEvent, withTransaction, type ShardPools } from '@tickets/db';
import {
  InternalError,
  OUTBOX_EVENT_TYPES,
  type OrderConfirmedPayload,
  type OrderRefundedPayload,
  type PaymentSucceededPayload,
} from '@tickets/domain';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import { insertOutboxEvent } from '../repositories/outbox-repository.js';
import { getOrderForPayment, markOrderStatus } from '../repositories/orders-repository.js';
import {
  getPaymentStatusById,
  markPaymentSucceeded,
  markPaymentStatus,
} from '../repositories/payments-repository.js';
import { claimProcessedMessage } from '../repositories/processed-messages-repository.js';
import {
  getSeatPricesForReservation,
  markReservationConverted,
  markSeatsSold,
} from '../repositories/reservation-repository.js';
import { insertTicket } from '../repositories/tickets-repository.js';
import { createQrToken } from './qr-token.js';

const CONSUMER_NAME = 'booking-api.payment-succeeded';

export interface PaymentConsumerDeps {
  readonly shardPools: ShardPools;
  readonly stripe: Stripe;
  readonly qrTokenSecret: string;
}

/**
 * The RabbitMQ consumer base (@tickets/rabbit) hands handlers an
 * `unknown` payload — it crossed a JSON (de)serialization boundary, so
 * it gets the same "never trust it blindly" treatment as any other
 * external input, even though it's our own outbox event.
 */
export function parsePaymentSucceededPayload(payload: unknown): PaymentSucceededPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new InternalError('payment.succeeded payload is not an object', { payload });
  }
  // Redan kontrollerat att det är ett icke-null objekt ovan — castet
  // vidgar bara indexsignaturen så fälten kan läsas ut och valideras
  // ett och ett nedan, det är INTE ett antagande om att formen är rätt.
  const { paymentId, orderId, reservationId, eventId, providerRef, providerChargeRef } =
    payload as Record<string, unknown>;
  if (
    typeof paymentId !== 'string' ||
    typeof orderId !== 'string' ||
    typeof reservationId !== 'string' ||
    typeof eventId !== 'string' ||
    typeof providerRef !== 'string' ||
    typeof providerChargeRef !== 'string'
  ) {
    throw new InternalError('payment.succeeded payload is missing required fields', {
      payload,
    });
  }
  return { paymentId, orderId, reservationId, eventId, providerRef, providerChargeRef };
}

type ProcessOutcome = { readonly kind: 'duplicate' | 'converted' | 'refund_needed' };

export async function processPaymentSucceeded(
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
  messageId: string | undefined,
): Promise<void> {
  if (messageId === undefined) {
    throw new InternalError('payment.succeeded message is missing its messageId', { payload });
  }
  const pool = getPoolForEvent(deps.shardPools, payload.eventId);

  const outcome = await withTransaction(pool, (client) =>
    convertReservationOrFlagRefund(client, deps, payload, messageId),
  );
  if (outcome.kind === 'refund_needed') {
    await refundAndNotify(deps, pool, payload);
    return;
  }
  if (outcome.kind === 'duplicate') {
    // Redelivery (requeue efter krasch, eller x-delivery-limit-retry):
    // dedupe-claimen i den FÖRSTA transaktionen är redan tagen, så vi
    // hamnar aldrig i grenen ovan igen för det här försöket. Om
    // betalningen fortfarande står i "refund_needed" är återbetalningen
    // från förra försöket inte klar — annars skulle pengarna vara
    // dragna för gott utan motprestation (docs/plan.md "Betalning som
    // landar efter utgången reservation"). `refundAndNotify` är säker
    // att köra flera gånger (Stripes idempotencyKey + det villkorade
    // UPDATE:et nedan).
    const currentStatus = await getPaymentStatusById(pool, payload.eventId, payload.paymentId);
    if (currentStatus === 'refund_needed') {
      await refundAndNotify(deps, pool, payload);
    }
  }
}

async function convertReservationOrFlagRefund(
  client: PoolClient,
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
  messageId: string,
): Promise<ProcessOutcome> {
  const claimed = await claimProcessedMessage(client, {
    eventId: payload.eventId,
    messageId,
    consumer: CONSUMER_NAME,
  });
  if (!claimed) {
    return { kind: 'duplicate' };
  }

  const paymentMarked = await markPaymentSucceeded(
    client,
    payload.eventId,
    payload.paymentId,
    payload.providerChargeRef,
  );
  if (!paymentMarked) {
    throw new InternalError(
      'Payment was not in "pending" status when payment.succeeded arrived',
      {
        paymentId: payload.paymentId,
      },
    );
  }

  const converted = await markReservationConverted(
    client,
    payload.eventId,
    payload.reservationId,
  );
  if (!converted) {
    // Varaktigt skrivet i SAMMA transaktion som dedupe-claimen — en
    // krasch mellan denna commit och det faktiska Stripe-återbetalnings-
    // anropet lämnar betalningen synligt fast i "refund_needed", inte
    // tyst förlorad. En periodisk sweeper för fastnade rader här är ett
    // rimligt uppföljningssteg, inte byggt i den här omgången.
    await markPaymentStatus(
      client,
      payload.eventId,
      payload.paymentId,
      'succeeded',
      'refund_needed',
    );
    return { kind: 'refund_needed' };
  }

  await convertOrderAndMintTickets(client, deps, payload);
  return { kind: 'converted' };
}

async function convertOrderAndMintTickets(
  client: PoolClient,
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
): Promise<void> {
  const order = await getOrderForPayment(client, payload.eventId, payload.orderId);
  if (order === undefined) {
    throw new InternalError('Order not found while converting a paid reservation', {
      orderId: payload.orderId,
    });
  }
  const orderMarked = await markOrderStatus(
    client,
    payload.eventId,
    payload.orderId,
    'pending',
    'paid',
  );
  if (!orderMarked) {
    throw new InternalError('Order was not "pending" when its reservation converted', {
      orderId: payload.orderId,
    });
  }

  const seats = await getSeatPricesForReservation(
    client,
    payload.eventId,
    payload.reservationId,
  );
  await markSeatsSold(client, payload.eventId, payload.reservationId);
  const ticketIds: string[] = [];
  for (const seat of seats) {
    const qrToken = createQrToken(deps.qrTokenSecret, payload.orderId, seat.seatId);
    const ticket = await insertTicket(client, {
      eventId: payload.eventId,
      orderId: payload.orderId,
      seatId: seat.seatId,
      qrToken,
    });
    ticketIds.push(ticket.id);
  }

  const confirmedPayload: OrderConfirmedPayload = {
    orderId: payload.orderId,
    eventId: payload.eventId,
    userId: order.userId,
    ticketIds,
  };
  await insertOutboxEvent(client, {
    eventId: payload.eventId,
    type: OUTBOX_EVENT_TYPES.ORDER_CONFIRMED,
    payload: confirmedPayload,
  });
}

/**
 * Skyddsnätet (docs/plan.md "Betalning som landar efter utgången
 * reservation"): frysningen löste det normala fallet, men hann den gå
 * ut INNAN betalningen bekräftades är pengarna redan dragna och
 * stolarna redan sålda till någon annan — återbetala, berätta för
 * kunden, aldrig behåll pengarna utan motprestation.
 *
 * Stripe-anropet ligger medvetet UTANFÖR transaktionen nedan, av samma
 * skäl som i checkout-service.ts — men ordern/betalningen flaggas redan
 * `refund_needed`-läge av den FÖRRA transaktionen (reservationen är
 * redan konstaterat förlorad där), så ett krasch MELLAN detta anrop och
 * nästa transaktion lämnar bara en försenad återbetalning, aldrig en
 * dubbel eller en utebliven.
 */
async function refundAndNotify(
  deps: PaymentConsumerDeps,
  pool: Pool,
  payload: PaymentSucceededPayload,
): Promise<void> {
  await deps.stripe.refunds.create(
    { payment_intent: payload.providerChargeRef },
    { idempotencyKey: `refund:${payload.paymentId}` },
  );
  await withTransaction(pool, async (client) => {
    // Villkorat UPDATE: gör hela funktionen säker att köra flera
    // gånger (se anropsplatsen i processPaymentSucceeded). Har ett
    // tidigare försök redan hunnit flippa statusen till "refunded"
    // ska vi inte avbryta ordern eller skriva outbox-händelsen igen.
    const statusFlipped = await markPaymentStatus(
      client,
      payload.eventId,
      payload.paymentId,
      'refund_needed',
      'refunded',
    );
    if (!statusFlipped) {
      return;
    }
    await markOrderStatus(client, payload.eventId, payload.orderId, 'pending', 'cancelled');
    const refundedPayload: OrderRefundedPayload = {
      paymentId: payload.paymentId,
      orderId: payload.orderId,
      eventId: payload.eventId,
      reservationId: payload.reservationId,
    };
    await insertOutboxEvent(client, {
      eventId: payload.eventId,
      type: OUTBOX_EVENT_TYPES.ORDER_REFUNDED,
      payload: refundedPayload,
    });
  });
}
