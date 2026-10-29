import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createMockCheckoutHandler } from '../../src/controllers/mock-checkout-controller.js';
import { createSessionStore } from '../../src/services/session-store.js';

function fakeReply(): {
  reply: FastifyReply;
  redirect: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const redirect = vi.fn();
  const code = vi.fn().mockReturnValue({ send });
  return { reply: { redirect, code } as unknown as FastifyReply, redirect, send, code };
}

function sessionWith(
  successUrl: string,
): Parameters<ReturnType<typeof createSessionStore>['set']>[0] {
  return {
    id: 'cs_mock_1',
    paymentIntentId: 'pi_mock_1',
    amountTotal: 1000,
    customerEmail: 'user@example.test',
    successUrl,
    cancelUrl: 'https://app.test/cancel',
    metadata: {},
  };
}

describe('createMockCheckoutHandler', () => {
  it('svarar 302 till success_url med {CHECKOUT_SESSION_ID} ersatt', async () => {
    const sessionStore = createSessionStore();
    sessionStore.set(
      sessionWith('https://app.test/success?order_id=o1&session_id={CHECKOUT_SESSION_ID}'),
    );
    const { reply, redirect } = fakeReply();

    await createMockCheckoutHandler(sessionStore)(
      { params: { sessionId: 'cs_mock_1' } } as unknown as FastifyRequest,
      reply,
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.test/success?order_id=o1&session_id=cs_mock_1',
      302,
    );
  });

  it('svarar 404 för en okänd session', async () => {
    const { reply, redirect, code } = fakeReply();

    await createMockCheckoutHandler(createSessionStore())(
      { params: { sessionId: 'nope' } } as unknown as FastifyRequest,
      reply,
    );

    expect(code).toHaveBeenCalledWith(404);
    expect(redirect).not.toHaveBeenCalled();
  });
});
