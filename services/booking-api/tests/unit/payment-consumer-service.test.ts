import type { ShardPools } from '@tickets/db';
import type { PaymentSucceededPayload } from '@tickets/domain';
import type { Logger, OversellMetrics } from '@tickets/observability';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePaymentSucceededPayload,
  processPaymentSucceeded,
} from '../../src/services/payment-consumer-service.js';

const PAYLOAD: PaymentSucceededPayload = {
  paymentId: 'payment-1',
  orderId: 'order-1',
  reservationId: 'res-1',
  eventId: 'event-1',
  providerRef: 'cs_test_1',
  providerChargeRef: 'pi_test_1',
};

interface FakeOptions {
  readonly reservationConverts: boolean;
  readonly seatIds?: readonly string[];
  /** rowCount from the generic `markPaymentStatus` UPDATE — 0 simulates a second, already-done flip. */
  readonly paymentStatusFlips?: number;
  /** Simulates a REDELIVERED message: the processed_messages INSERT finds the row already there. */
  readonly alreadyProcessed?: boolean;
  /** What `getPaymentStatusById` (used on the "duplicate" path) reports the payment's current status as. */
  readonly currentPaymentStatus?: string;
  /** Simulates the tickets_valid_seat_unique constraint rejecting these seats' inserts. */
  readonly ticketConflictSeatIds?: readonly string[];
  /**
   * Simulates tickets that already exist for this order from a PRIOR
   * (crashed) attempt — only read via getTicketedSeatIds on the
   * duplicate-redelivery recovery path, independent of what this call
   * itself inserts.
   */
  readonly alreadyTicketedSeatIds?: readonly string[];
}

function fakeDeps(options: FakeOptions): {
  deps: {
    shardPools: ShardPools;
    stripe: Stripe;
    qrTokenSecret: string;
    logger: Logger;
    oversellMetrics: OversellMetrics;
  };
  calls: {
    refundsCreate: ReturnType<typeof vi.fn>;
    insertedTicketSeatIds: string[];
    releasedConflictedSeatIds: string[];
    outboxTypes: string[];
    outboxPayloads: Record<string, unknown>[];
    oversellPreventedInc: ReturnType<typeof vi.fn>;
    loggerWarn: ReturnType<typeof vi.fn>;
  };
} {
  const refundsCreate = vi.fn().mockResolvedValue({ id: 're_test_1' });
  const insertedTicketSeatIds: string[] = [];
  const releasedConflictedSeatIds: string[] = [];
  const outboxTypes: string[] = [];
  const outboxPayloads: Record<string, unknown>[] = [];
  const oversellPreventedInc = vi.fn();
  const loggerWarn = vi.fn();
  const seatIds = options.seatIds ?? ['seat-1', 'seat-2'];
  const conflictSeatIds = new Set(options.ticketConflictSeatIds ?? []);

  function dispatch(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes('INSERT INTO processed_messages')) {
      return Promise.resolve({ rows: [], rowCount: options.alreadyProcessed ? 0 : 1 });
    }
    if (sql.includes("SET status = 'succeeded'")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes("SET status = 'converted'")) {
      return Promise.resolve({ rows: [], rowCount: options.reservationConverts ? 1 : 0 });
    }
    // markPaymentStatus (generic, used to flag "refund_needed" and to flip
    // it to "refunded") inlines neither status literally — both are bound
    // params ($3 from, $4 to) — so one branch covers both calls. Always
    // "succeeds" here; the idempotency-on-retry behavior (a SECOND flip
    // finding 0 rows) has its own dedicated test below.
    if (sql.includes('UPDATE payments SET status = $4')) {
      return Promise.resolve({ rows: [], rowCount: options.paymentStatusFlips ?? 1 });
    }
    if (sql.includes('FROM orders')) {
      return Promise.resolve({
        rows: [
          {
            id: 'order-1',
            event_id: 'event-1',
            user_id: 'user-1',
            reservation_id: 'res-1',
            total_cents: 2000,
          },
        ],
        rowCount: 1,
      });
    }
    if (sql.includes('UPDATE orders SET status')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes('SELECT id, price_cents FROM seats')) {
      return Promise.resolve({
        rows: seatIds.map((id) => ({ id, price_cents: 1000 })),
        rowCount: seatIds.length,
      });
    }
    if (sql.includes("UPDATE seats SET status = 'available'")) {
      if (params !== undefined) {
        releasedConflictedSeatIds.push(String(params[1]));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (sql.includes('INSERT INTO tickets')) {
      const seatId = params === undefined ? undefined : String(params[2]);
      if (seatId !== undefined && conflictSeatIds.has(seatId)) {
        return Promise.reject(
          Object.assign(new Error('duplicate key value'), {
            code: '23505',
            constraint: 'tickets_valid_seat_unique',
          }),
        );
      }
      if (seatId !== undefined) {
        insertedTicketSeatIds.push(seatId);
      }
      return Promise.resolve({ rows: [{ id: 'ticket-1' }], rowCount: 1 });
    }
    if (sql.includes('SELECT seat_id FROM tickets')) {
      return Promise.resolve({
        rows: (options.alreadyTicketedSeatIds ?? []).map((id) => ({ seat_id: id })),
        rowCount: (options.alreadyTicketedSeatIds ?? []).length,
      });
    }
    if (sql.includes('INSERT INTO outbox')) {
      if (params !== undefined) {
        outboxTypes.push(String(params[1]));
        outboxPayloads.push(JSON.parse(String(params[2])) as Record<string, unknown>);
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    // SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO SAVEPOINT and BEGIN/COMMIT/
    // ROLLBACK — no return value needed, just must not reject.
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  const client = {
    query: vi.fn().mockImplementation(dispatch),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    // getPaymentStatusById / getSeatPricesForReservation / getTicketedSeatIds
    // on the duplicate-redelivery recovery path read via the POOL directly,
    // outside any transaction — never through `client`.
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT status FROM payments')) {
        return Promise.resolve({
          rows: [{ status: options.currentPaymentStatus ?? 'succeeded' }],
        });
      }
      return dispatch(sql, params);
    }),
  };
  const shardPools = { pools: [pool, pool] } as unknown as ShardPools;
  const stripe = { refunds: { create: refundsCreate } } as unknown as Stripe;

  const logger = {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const oversellMetrics = {
    oversellPreventedTotal: { inc: oversellPreventedInc },
  } as unknown as OversellMetrics;

  return {
    deps: { shardPools, stripe, qrTokenSecret: 'qr-secret', logger, oversellMetrics },
    calls: {
      refundsCreate,
      insertedTicketSeatIds,
      releasedConflictedSeatIds,
      outboxTypes,
      outboxPayloads,
      oversellPreventedInc,
      loggerWarn,
    },
  };
}

describe('parsePaymentSucceededPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(parsePaymentSucceededPayload({ ...PAYLOAD })).toEqual(PAYLOAD);
  });

  it('rejects a payload missing a required field', () => {
    const { providerChargeRef, ...incomplete } = PAYLOAD;
    void providerChargeRef;
    expect(() => parsePaymentSucceededPayload(incomplete)).toThrow();
  });
});

describe('processPaymentSucceeded', () => {
  it('converts the reservation, mints one ticket per seat, and never calls refunds.create', async () => {
    const { deps, calls } = fakeDeps({
      reservationConverts: true,
      seatIds: ['seat-1', 'seat-2'],
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.insertedTicketSeatIds.sort()).toEqual(['seat-1', 'seat-2']);
    expect(calls.outboxTypes).toContain('order.confirmed');
    expect(calls.refundsCreate).not.toHaveBeenCalled();
  });

  it('refunds via Stripe instead of minting tickets when the reservation already expired', async () => {
    const { deps, calls } = fakeDeps({ reservationConverts: false });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.insertedTicketSeatIds).toHaveLength(0);
    expect(calls.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_1' },
      { idempotencyKey: 'refund:payment-1' },
    );
    expect(calls.outboxTypes).toContain('order.refunded');
    expect(calls.outboxTypes).not.toContain('order.confirmed');
  });

  it('throws instead of silently proceeding when the outbox message has no messageId', async () => {
    const { deps } = fakeDeps({ reservationConverts: true });
    await expect(processPaymentSucceeded(deps, PAYLOAD, undefined)).rejects.toThrow();
  });

  it('retries the refund on a redelivered message if the payment is still stuck in refund_needed', async () => {
    // Simulates: first attempt flagged refund_needed and committed, then
    // crashed before the Stripe call — RabbitMQ redelivers, dedupe says
    // "duplicate", but the money is still unrefunded (docs/plan.md
    // "Betalning som landar efter utgången reservation").
    const { deps, calls } = fakeDeps({
      reservationConverts: false,
      alreadyProcessed: true,
      currentPaymentStatus: 'refund_needed',
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_1' },
      { idempotencyKey: 'refund:payment-1' },
    );
    expect(calls.outboxTypes).toContain('order.refunded');
  });

  it('does not re-refund a redelivered message once the payment has already been refunded', async () => {
    const { deps, calls } = fakeDeps({
      reservationConverts: false,
      alreadyProcessed: true,
      currentPaymentStatus: 'refunded',
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.refundsCreate).not.toHaveBeenCalled();
  });

  it('mints tickets for the seats that cleared, releases and partially refunds the one that lost the oversell race', async () => {
    const { deps, calls } = fakeDeps({
      reservationConverts: true,
      seatIds: ['seat-1', 'seat-2'],
      ticketConflictSeatIds: ['seat-2'],
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.insertedTicketSeatIds).toEqual(['seat-1']);
    expect(calls.releasedConflictedSeatIds).toEqual(['seat-2']);
    expect(calls.oversellPreventedInc).toHaveBeenCalledOnce();
    expect(calls.loggerWarn).toHaveBeenCalledOnce();
    expect(calls.outboxTypes).toContain('order.confirmed');
    expect(calls.outboxTypes).toContain('order.seat_refunded');
    expect(calls.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_1', amount: 1000 },
      { idempotencyKey: 'partial-refund:payment-1' },
    );
    const seatRefundedPayload = calls.outboxPayloads.find(
      (p) => Array.isArray(p['seatIds']) && (p['seatIds'] as unknown[]).includes('seat-2'),
    );
    expect(seatRefundedPayload).toMatchObject({ amountCents: 1000 });
  });

  it('falls back to a full refund when every selected seat loses the oversell race', async () => {
    const { deps, calls } = fakeDeps({
      reservationConverts: true,
      seatIds: ['seat-1', 'seat-2'],
      ticketConflictSeatIds: ['seat-1', 'seat-2'],
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.insertedTicketSeatIds).toHaveLength(0);
    expect(calls.outboxTypes).not.toContain('order.confirmed');
    expect(calls.outboxTypes).toContain('order.refunded');
    expect(calls.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_1' },
      { idempotencyKey: 'refund:payment-1' },
    );
  });

  it('recovers a partial refund on redelivery if it crashed before the Stripe call last time', async () => {
    // First attempt converted the order, minted a ticket for seat-1, but
    // crashed before refundSeatsAndNotify's Stripe call for seat-2 — no
    // separate "pending" marker was left, so the duplicate branch must
    // recompute it from the tickets table itself.
    const { deps, calls } = fakeDeps({
      reservationConverts: true,
      seatIds: ['seat-1', 'seat-2'],
      alreadyProcessed: true,
      currentPaymentStatus: 'succeeded',
      alreadyTicketedSeatIds: ['seat-1'],
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.refundsCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_1', amount: 1000 },
      { idempotencyKey: 'partial-refund:payment-1' },
    );
    expect(calls.outboxTypes).toContain('order.seat_refunded');
  });

  it('does nothing on redelivery once every reserved seat already has a valid ticket', async () => {
    const { deps, calls } = fakeDeps({
      reservationConverts: true,
      seatIds: ['seat-1', 'seat-2'],
      alreadyProcessed: true,
      currentPaymentStatus: 'succeeded',
      alreadyTicketedSeatIds: ['seat-1', 'seat-2'],
    });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.refundsCreate).not.toHaveBeenCalled();
  });

  it('skips the order-cancel and outbox write if the payment status flip already happened (idempotent refundAndNotify)', async () => {
    // The Stripe call succeeds (idempotent on its own key) but the local
    // "flip to refunded" UPDATE finds 0 rows — another attempt already
    // completed it. Must not cancel the order or write outbox twice.
    const { deps, calls } = fakeDeps({ reservationConverts: false, paymentStatusFlips: 0 });

    await processPaymentSucceeded(deps, PAYLOAD, 'outbox-event-1');

    expect(calls.refundsCreate).toHaveBeenCalledOnce();
    expect(calls.outboxTypes).not.toContain('order.refunded');
  });
});
