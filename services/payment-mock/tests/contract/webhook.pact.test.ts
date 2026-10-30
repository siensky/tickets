/**
 * Pact-konsumenttest: payment-mock → booking-api, `POST /webhooks/stripe`
 * (docs/plan.md 7.9, kontrakt 3: payload + headerformat). Kör den RIKTIGA
 * leveranskoden (`scheduleWebhookDelivery`) mot Pacts mockserver och skriver
 * `pacts/payment-mock-booking-api.json`. booking-api verifierar den i
 * services/booking-api/tests/contract. Signaturens exakta värde ingår inte:
 * bara formatet (`t=<tid>,v1=<hex>`); providern signerar om med sin hemlighet.
 *
 * Dagens webhook-401 (fel secret) fångas INTE av detta: det är
 * driftkonfiguration, inte kontraktsform (docs/plan.md 7.9).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matchers, PactV4 } from '@pact-foundation/pact';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleWebhookDelivery } from '../../src/services/webhook-delivery-service.js';
import type { StoredSession } from '../../src/services/session-store.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');

const SESSION: StoredSession = {
  id: 'cs_mock_contract',
  paymentIntentId: 'pi_mock_contract',
  amountTotal: 109_000,
  customerEmail: 'buyer@example.test',
  successUrl: 'https://app.test/success',
  cancelUrl: 'https://app.test/cancel',
  metadata: {
    orderId: '5b0f1a9e-3c6d-4f7a-8d2e-1a2b3c4d5e6f',
    eventId: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
    reservationId: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('payment-mock → booking-api: POST /webhooks/stripe', () => {
  it('skickar checkout.session.completed med en Stripe-formaterad signatur', async () => {
    const pact = new PactV4({
      consumer: 'payment-mock',
      provider: 'booking-api',
      dir: PACTS_DIR,
      logLevel: 'warn',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await pact
      .addInteraction()
      .given('a pending payment exists for the checkout session')
      .uponReceiving('a checkout.session.completed webhook')
      .withRequest('POST', '/webhooks/stripe', (builder) => {
        builder
          .headers({
            'content-type': 'application/json',
            'stripe-signature': Matchers.regex(
              /^t=\d+,v1=[0-9a-f]{64}$/,
              `t=1,v1=${'a'.repeat(64)}`,
            ),
          })
          .jsonBody({
            id: Matchers.string('evt_mock_contract'),
            object: 'event',
            type: 'checkout.session.completed',
            api_version: Matchers.string('2024-06-20'),
            created: Matchers.integer(1_793_314_009),
            data: {
              object: {
                id: SESSION.id,
                object: 'checkout.session',
                payment_status: 'paid',
                payment_intent: SESSION.paymentIntentId,
                amount_total: Matchers.integer(SESSION.amountTotal),
                customer_email: Matchers.string(SESSION.customerEmail),
                metadata: SESSION.metadata,
              },
            },
          });
      })
      .willRespondWith(200, (builder) => {
        builder.jsonBody({
          kind: Matchers.regex(/^(processed|ignored|duplicate)$/, 'processed'),
        });
      })
      .executeTest(async (mockServer) => {
        scheduleWebhookDelivery(
          {
            webhookUrl: `${mockServer.url}/webhooks/stripe`,
            webhookSecret: 'whsec_contract',
            chaosConfig: {
              latencyMinMs: 0,
              latencyMaxMs: 0,
              failureRate: 0,
              duplicateWebhookRate: 0,
              lateWebhookRate: 0,
              lateWebhookDelayMs: 0,
            },
            logger: createLogger({ serviceName: 'pact-test' }),
          },
          SESSION,
        );
        await vi.waitFor(() => {
          expect(fetchSpy).toHaveBeenCalled();
        });
        const response: unknown = await fetchSpy.mock.results[0]?.value;
        expect(response).toMatchObject({ status: 200 });
      });
  });
});
