import {
  IdempotencyConflictError,
  NotFoundError,
  ReservationNotInExpectedStatusError,
} from '@tickets/domain';
import type { ShardPools } from '@tickets/db';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  createCheckout,
  type CheckoutServiceDeps,
} from '../../src/services/checkout-service.js';
import { computeCheckoutRequestHash, deriveOrderId } from '../../src/services/request-hash.js';
import type { CreateCheckoutInput } from '../../src/types/payment.js';

function input(overrides: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput {
  return {
    eventId: 'event-1',
    reservationId: 'res-1',
    queueTokenId: 'queue-1',
    idempotencyKey: 'idem-1',
    auth0Sub: 'auth0|user-1',
    email: 'user@example.test',
    name: 'Testy McTest',
    ...overrides,
  };
}

interface FakeOptions {
  readonly reservationStatus: string;
  readonly reservationQueueTokenId: string;
  readonly idempotencyRows?: {
    request_hash: string;
    status: string;
    response_body: unknown;
  }[];
  readonly freezeSucceeds?: boolean;
}

function fakeDeps(options: FakeOptions): {
  deps: CheckoutServiceDeps;
  sessionsCreate: ReturnType<typeof vi.fn>;
} {
  const sessionsCreate = vi
    .fn()
    .mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.test/cs_test_1' });
  let idempotencyRows = options.idempotencyRows ?? [];

  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO idempotency_keys')) {
      // First attempt always wins the claim unless a row was pre-seeded via options.
      return Promise.resolve({
        rows: idempotencyRows.length === 0 ? [{ event_id: 'event-1' }] : [],
      });
    }
    if (sql.includes('SELECT request_hash')) {
      return Promise.resolve({ rows: idempotencyRows });
    }
    if (sql.includes('UPDATE idempotency_keys SET status')) {
      idempotencyRows = [
        {
          request_hash: idempotencyRows[0]?.request_hash ?? '',
          status: 'completed',
          response_body: {},
        },
      ];
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('DELETE FROM idempotency_keys')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM reservations r')) {
      return Promise.resolve({
        rows: [
          {
            id: 'res-1',
            event_id: 'event-1',
            queue_token_id: options.reservationQueueTokenId,
            status: options.reservationStatus,
            expires_at: new Date(),
            seat_ids: ['seat-1', 'seat-2'],
          },
        ],
      });
    }
    if (sql.includes('FROM seats')) {
      return Promise.resolve({
        rows: [
          { id: 'seat-1', price_cents: 1000 },
          { id: 'seat-2', price_cents: 1500 },
        ],
      });
    }
    if (sql.includes('INSERT INTO users')) {
      return Promise.resolve({ rows: [{ id: 'user-1' }] });
    }
    if (sql.includes('INSERT INTO orders')) {
      return Promise.resolve({ rows: [{ id: 'order-1' }] });
    }
    if (sql.includes('INSERT INTO payments')) {
      return Promise.resolve({ rows: [{ id: 'payment-1' }] });
    }
    if (sql.includes("SET status = 'pending_payment'")) {
      return Promise.resolve({ rowCount: (options.freezeSucceeds ?? true) ? 1 : 0 });
    }
    if (sql.includes('SELECT status FROM reservations')) {
      return Promise.resolve({ rows: [{ status: options.reservationStatus }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn().mockResolvedValue(client) };
  const shardPools = { pools: [pool, pool] } as unknown as ShardPools;
  const stripe = { checkout: { sessions: { create: sessionsCreate } } } as unknown as Stripe;

  return {
    deps: {
      shardPools,
      stripe,
      paymentFrozenMinutes: 10,
      successUrl: 'https://x.test/ok',
      cancelUrl: 'https://x.test/cancel',
    },
    sessionsCreate,
  };
}

describe('createCheckout', () => {
  it('creates a Stripe session and returns the order id and checkout URL', async () => {
    const { deps, sessionsCreate } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'queue-1',
    });

    const result = await createCheckout(deps, input());

    expect(result).toEqual({
      orderId: 'order-1',
      checkoutUrl: 'https://checkout.test/cs_test_1',
    });
    expect(sessionsCreate).toHaveBeenCalledOnce();
  });

  it('computes the total from the server-side seat prices, never trusting a client-supplied amount', async () => {
    const { deps, sessionsCreate } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'queue-1',
    });

    await createCheckout(deps, input());

    const [sessionParams] = sessionsCreate.mock.calls[0] as [
      { line_items: { price_data: { unit_amount: number } }[] },
    ];
    expect(sessionParams.line_items[0]?.price_data.unit_amount).toBe(2500);
  });

  it('lägger event_id och order_id på success_url och event_id och reservation_id på cancel_url', async () => {
    const { deps, sessionsCreate } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'queue-1',
    });

    await createCheckout({ ...deps, successUrl: 'https://x.test/ok?lang=sv' }, input());

    const [sessionParams] = sessionsCreate.mock.calls[0] as [
      { success_url: string; cancel_url: string },
    ];
    const success = new URL(sessionParams.success_url);
    expect(success.searchParams.get('lang')).toBe('sv');
    expect(success.searchParams.get('event_id')).toBe('event-1');
    expect(success.searchParams.get('order_id')).toBe(deriveOrderId('res-1'));
    const cancel = new URL(sessionParams.cancel_url);
    expect(cancel.searchParams.get('event_id')).toBe('event-1');
    expect(cancel.searchParams.get('reservation_id')).toBe('res-1');
  });

  it('rejects when the reservation belongs to a different queue token (IDOR)', async () => {
    const { deps } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'someone-elses-token',
    });

    await expect(createCheckout(deps, input())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects when the reservation is not active', async () => {
    const { deps } = fakeDeps({
      reservationStatus: 'pending_payment',
      reservationQueueTokenId: 'queue-1',
    });

    await expect(createCheckout(deps, input())).rejects.toBeInstanceOf(
      ReservationNotInExpectedStatusError,
    );
  });

  it('replays the stored response instead of calling Stripe again for a completed idempotency key', async () => {
    const { deps, sessionsCreate } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'queue-1',
      idempotencyRows: [
        {
          request_hash: computeCheckoutRequestHash(input()),
          status: 'completed',
          response_body: {
            orderId: 'order-replayed',
            checkoutUrl: 'https://checkout.test/replayed',
          },
        },
      ],
    });

    const result = await createCheckout(deps, input());

    expect(result).toEqual({
      orderId: 'order-replayed',
      checkoutUrl: 'https://checkout.test/replayed',
    });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects a reused idempotency key whose request hash differs', async () => {
    const { deps } = fakeDeps({
      reservationStatus: 'active',
      reservationQueueTokenId: 'queue-1',
      idempotencyRows: [
        { request_hash: 'some-other-hash', status: 'completed', response_body: {} },
      ],
    });

    await expect(createCheckout(deps, input())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });
});
