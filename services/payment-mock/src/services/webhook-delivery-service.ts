/**
 * Levererar den simulerade webhooken asynkront, med kaos (docs/plan.md
 * "payment-mock för lasttest"). Schemaläggs med `setTimeout` i stället
 * för att spåras för graceful shutdown — en timer som aldrig hinner
 * köra vid en omstart är likvärdigt med en tappad webhook, vilket redan
 * är ett giltigt kaosutfall, inte en bugg som behöver täckas.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@tickets/observability';
import { randomLatencyMs, rollBoolean, type ChaosConfig } from './chaos-config.js';
import { signWebhookPayload } from './webhook-signer.js';
import type { StoredSession } from './session-store.js';

export interface WebhookDeliveryDeps {
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly chaosConfig: ChaosConfig;
  readonly logger: Logger;
}

function buildCheckoutCompletedEventPayload(session: StoredSession): string {
  return JSON.stringify({
    id: `evt_mock_${randomUUID()}`,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: session.id,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: session.paymentIntentId,
        amount_total: session.amountTotal,
        customer_email: session.customerEmail,
        metadata: session.metadata,
      },
    },
  });
}

async function deliverOnce(deps: WebhookDeliveryDeps, payload: string): Promise<void> {
  const signature = signWebhookPayload(payload, deps.webhookSecret);
  const response = await fetch(deps.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  if (!response.ok) {
    deps.logger.warn(
      { status: response.status },
      'payment-mock webhook delivery got a non-2xx response',
    );
  }
}

function deliverAndLog(deps: WebhookDeliveryDeps, payload: string, label: string): void {
  deliverOnce(deps, payload).catch((error: unknown) => {
    deps.logger.warn({ error, label }, 'payment-mock webhook delivery failed');
  });
}

/**
 * ~5 % av betalningarna misslyckas helt (docs/plan.md "~5 % fel") —
 * ingen webhook alls, precis som en riktig avvisad betalning aldrig
 * triggar `checkout.session.completed`.
 */
export function scheduleWebhookDelivery(
  deps: WebhookDeliveryDeps,
  session: StoredSession,
): void {
  if (rollBoolean(deps.chaosConfig.failureRate)) {
    deps.logger.info(
      { sessionId: session.id },
      'payment-mock: simulated payment failure, no webhook sent',
    );
    return;
  }

  const isLate = rollBoolean(deps.chaosConfig.lateWebhookRate);
  const delayMs = isLate
    ? deps.chaosConfig.lateWebhookDelayMs
    : randomLatencyMs(deps.chaosConfig);
  const payload = buildCheckoutCompletedEventPayload(session);

  setTimeout(() => {
    deliverAndLog(deps, payload, 'primary');
    if (rollBoolean(deps.chaosConfig.duplicateWebhookRate)) {
      setTimeout(() => deliverAndLog(deps, payload, 'duplicate'), 100);
    }
  }, delayMs);
}
