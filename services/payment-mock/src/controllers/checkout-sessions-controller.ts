/**
 * Stripe-API-kompatibel YTA för `POST /v1/checkout/sessions` (docs/plan.md
 * "payment-mock för lasttest"). Avsiktligt NÄRA, inte en fullständig
 * Stripe-emulering — den förstår bara de fält `stripe`-SDK:t faktiskt
 * skickar för booking-apis egna anrop (docs/rules.md §11: inga nya
 * beroenden, så ingen generell form-parser-lib — fälten läses direkt
 * via `URLSearchParams`, Stripes platta `metadata[x]`-notation är redan
 * flata nycklar i formuläret, ingen rekursiv parsning behövs).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChaosConfig } from '../services/chaos-config.js';
import { scheduleWebhookDelivery } from '../services/webhook-delivery-service.js';
import type { SessionStore } from '../services/session-store.js';
import type { Logger } from '@tickets/observability';

export interface CheckoutSessionsDeps {
  readonly sessionStore: SessionStore;
  readonly chaosConfig: ChaosConfig;
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly checkoutBaseUrl: string;
  readonly logger: Logger;
}

function parseFormBody(request: FastifyRequest): URLSearchParams {
  const raw = typeof request.body === 'string' ? request.body : '';
  return new URLSearchParams(raw);
}

export function createCreateCheckoutSessionHandler(deps: CheckoutSessionsDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = parseFormBody(request);
    const sessionId = `cs_mock_${randomUUID()}`;
    const session = {
      id: sessionId,
      paymentIntentId: `pi_mock_${randomUUID()}`,
      amountTotal: Number(params.get('line_items[0][price_data][unit_amount]') ?? '0'),
      customerEmail: params.get('customer_email') ?? '',
      successUrl: params.get('success_url') ?? '',
      cancelUrl: params.get('cancel_url') ?? '',
      metadata: {
        orderId: params.get('metadata[orderId]') ?? '',
        eventId: params.get('metadata[eventId]') ?? '',
        reservationId: params.get('metadata[reservationId]') ?? '',
      },
    };
    deps.sessionStore.set(session);
    scheduleWebhookDelivery(
      {
        webhookUrl: deps.webhookUrl,
        webhookSecret: deps.webhookSecret,
        chaosConfig: deps.chaosConfig,
        logger: deps.logger,
      },
      session,
    );

    reply.code(200).send({
      id: session.id,
      object: 'checkout.session',
      url: `${deps.checkoutBaseUrl}/${session.id}`,
      payment_status: 'unpaid',
      payment_intent: session.paymentIntentId,
      metadata: session.metadata,
    });
  };
}
