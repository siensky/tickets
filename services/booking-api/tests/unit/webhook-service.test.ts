import type { ShardPools } from '@tickets/db';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  handleStripeWebhook,
  type WebhookServiceDeps,
} from '../../src/services/webhook-service.js';

const WEBHOOK_SECRET = 'whsec_test_secret';

function buildWebhookRequest(overrides: Record<string, unknown> = {}): {
  rawBody: Buffer;
  signature: string;
} {
  const session = {
    id: 'cs_test_1',
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    metadata: { orderId: 'order-1', eventId: 'event-1', reservationId: 'res-1' },
    ...overrides,
  };
  const event = {
    id: 'evt_test_1',
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: { object: session },
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { rawBody: Buffer.from(payload), signature };
}

// `query` is matched on SQL content, not call order — withTransaction's
// own BEGIN/COMMIT/ROLLBACK statements also flow through this fake.
function fakeDeps(options: {
  claimInsertCount?: number;
  paymentRow?: {
    id: string;
    event_id: string;
    order_id: string;
    provider_ref: string;
    status: string;
  };
}): { deps: WebhookServiceDeps; insertOutbox: ReturnType<typeof vi.fn> } {
  const insertOutbox = vi.fn().mockResolvedValue(undefined);
  let claimCallsLeft = options.claimInsertCount ?? 1;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO processed_messages')) {
      const claimed = claimCallsLeft > 0;
      claimCallsLeft -= 1;
      return Promise.resolve({ rowCount: claimed ? 1 : 0 });
    }
    if (sql.includes('FROM payments')) {
      return Promise.resolve({
        rows: options.paymentRow !== undefined ? [options.paymentRow] : [],
      });
    }
    if (sql.includes('INSERT INTO outbox')) {
      insertOutbox();
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const shardPools = { pools: [pool, pool] } as unknown as ShardPools;
  const stripe = new Stripe('sk_test_fake');
  return { deps: { shardPools, stripe, webhookSecret: WEBHOOK_SECRET }, insertOutbox };
}

describe('handleStripeWebhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const { deps } = fakeDeps({});
    const { rawBody } = buildWebhookRequest();

    await expect(handleStripeWebhook(deps, rawBody, 't=1,v1=wrong')).rejects.toThrow();
  });

  it('ignores event types other than checkout.session.completed', async () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.created',
      data: { object: {} },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const { deps, insertOutbox } = fakeDeps({});

    const result = await handleStripeWebhook(deps, Buffer.from(payload), signature);

    expect(result).toEqual({ kind: 'ignored' });
    expect(insertOutbox).not.toHaveBeenCalled();
  });

  it('ignores a completed session whose payment_status is not "paid"', async () => {
    const { rawBody, signature } = buildWebhookRequest({ payment_status: 'unpaid' });
    const { deps, insertOutbox } = fakeDeps({});

    const result = await handleStripeWebhook(deps, rawBody, signature);

    expect(result).toEqual({ kind: 'ignored' });
    expect(insertOutbox).not.toHaveBeenCalled();
  });

  it('writes a payment.succeeded outbox event for a paid session, keyed by the found payment row', async () => {
    const { rawBody, signature } = buildWebhookRequest();
    const { deps, insertOutbox } = fakeDeps({
      paymentRow: {
        id: 'payment-1',
        event_id: 'event-1',
        order_id: 'order-1',
        provider_ref: 'cs_test_1',
        status: 'pending',
      },
    });

    const result = await handleStripeWebhook(deps, rawBody, signature);

    expect(result).toEqual({ kind: 'processed' });
    expect(insertOutbox).toHaveBeenCalledOnce();
  });

  it('returns "duplicate" and never writes a second outbox event when the Stripe event id was already seen', async () => {
    const { rawBody, signature } = buildWebhookRequest();
    const { deps, insertOutbox } = fakeDeps({ claimInsertCount: 0 });

    const result = await handleStripeWebhook(deps, rawBody, signature);

    expect(result).toEqual({ kind: 'duplicate' });
    expect(insertOutbox).not.toHaveBeenCalled();
  });
});
