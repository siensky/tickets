import { createLogger } from '@tickets/observability';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createCreateCheckoutSessionHandler } from '../../src/controllers/checkout-sessions-controller.js';
import { createSessionStore } from '../../src/services/session-store.js';

function fakeReply(): { reply: FastifyReply; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const reply = { code: vi.fn().mockReturnValue({ send }) } as unknown as FastifyReply;
  return { reply, send };
}

describe('createCreateCheckoutSessionHandler', () => {
  it('parses the form-encoded Stripe request, stores the session, and responds with a Checkout Session shape', async () => {
    const sessionStore = createSessionStore();
    const handler = createCreateCheckoutSessionHandler({
      sessionStore,
      // Never fires during this test — no timers are advanced.
      chaosConfig: {
        latencyMinMs: 60_000,
        latencyMaxMs: 60_000,
        failureRate: 0,
        duplicateWebhookRate: 0,
        lateWebhookRate: 0,
        lateWebhookDelayMs: 0,
      },
      webhookUrl: 'http://booking-api.test/webhooks/stripe',
      webhookSecret: 'secret',
      checkoutBaseUrl: 'http://payment-mock.test/mock-checkout',
      logger: createLogger({ serviceName: 'test' }),
    });
    const body = new URLSearchParams({
      'metadata[orderId]': 'order-1',
      'metadata[eventId]': 'event-1',
      'metadata[reservationId]': 'res-1',
      'line_items[0][price_data][unit_amount]': '2500',
      customer_email: 'user@example.test',
      success_url: 'https://app.test/success?order_id=order-1',
      cancel_url: 'https://app.test/cancel',
    }).toString();
    const request = { body } as unknown as FastifyRequest;
    const { reply, send } = fakeReply();

    await handler(request, reply);

    expect(send).toHaveBeenCalledOnce();
    const [response] = send.mock.calls[0] as [
      { id: string; url: string; metadata: Record<string, string> },
    ];
    expect(response.metadata).toEqual({
      orderId: 'order-1',
      eventId: 'event-1',
      reservationId: 'res-1',
    });
    expect(response.url).toBe(`http://payment-mock.test/mock-checkout/${response.id}`);

    const stored = sessionStore.get(response.id);
    expect(stored?.amountTotal).toBe(2500);
    expect(stored?.customerEmail).toBe('user@example.test');
    expect(stored?.successUrl).toBe('https://app.test/success?order_id=order-1');
    expect(stored?.cancelUrl).toBe('https://app.test/cancel');
  });
});
