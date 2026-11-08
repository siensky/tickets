/**
 * Levererar den simulerade webhooken asynkront, med kaos (docs/plan.md
 * "payment-mock för lasttest"), och försöker igen vid allt utom 2xx som
 * Stripe gör (lasttestet 7/11 tappade annars betalningar vars webhook kom
 * före betalningsraden). Schemaläggs med `setTimeout` i stället
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

/** Leveranser totalt per webhook. Stripe försöker igen vid allt utom 2xx, så mocken gör det också. */
export const WEBHOOK_DELIVERY_ATTEMPTS = 4;
const WEBHOOK_RETRY_BASE_DELAY_MS = 1000;

/** Statuskoden, eller `undefined` om anropet inte kom fram alls (nätverksfel). */
async function deliverOnce(
  deps: WebhookDeliveryDeps,
  payload: string,
): Promise<number | undefined> {
  const signature = signWebhookPayload(payload, deps.webhookSecret);
  try {
    const response = await fetch(deps.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    return response.status;
  } catch {
    return undefined;
  }
}

/**
 * Levererar och försöker igen vid allt utom 2xx, efter ungefär 1, 2 och 4 s med slumpad spridning:
 * webhooks som misslyckades samtidigt i en lasttopp ska inte komma tillbaka samtidigt. En loggrad per
 * misslyckat försök, och en till när mocken ger upp.
 */
export function deliverAndLog(
  deps: WebhookDeliveryDeps,
  payload: string,
  label: string,
  attempt = 1,
): void {
  void deliverOnce(deps, payload).then((status) => {
    if (status !== undefined && status >= 200 && status < 300) {
      return;
    }
    if (attempt >= WEBHOOK_DELIVERY_ATTEMPTS) {
      deps.logger.warn(
        { label, status, attempts: attempt },
        'payment-mock gave up delivering the webhook',
      );
      return;
    }
    deps.logger.warn(
      { label, status, attempt },
      'payment-mock webhook delivery failed, retrying',
    );
    const baseMs = WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const delayMs = baseMs * (0.5 + Math.random());
    setTimeout(() => deliverAndLog(deps, payload, label, attempt + 1), delayMs);
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
