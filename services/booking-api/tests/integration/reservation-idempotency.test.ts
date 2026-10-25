/**
 * Crown-jewel test #3 (docs/plan.md "Tester"): the same idempotency key
 * fired 10 times in parallel never creates more than one reservation
 * row, and every outcome is either that one reservation (a claim or a
 * replayed "completed" response) or an IdempotencyConflictError 409 —
 * never an empty response for a concurrent retry. How many of the 10
 * land in each bucket depends on runner-scheduling timing (see the
 * assertion comments below), so this intentionally doesn't assert an
 * exact 1-success/9-conflict split.
 */
import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '@tickets/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  warmPool,
  type TestDatabase,
} from './test-helpers.js';

describe('reservation idempotency (crown jewel #3)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('runs the operation exactly once for 10 parallel calls with the same key', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    const queueTokenId = randomUUID();
    const idempotencyKey = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [seatId] });
    await warmPool(db.shardPools.pools[0], 10);

    const attempts = Array.from({ length: 10 }, () =>
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatId],
        queueTokenId,
        idempotencyKey,
      }),
    );
    const outcomes = await Promise.allSettled(attempts);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    // At least one call must get through, and every rejection must be the
    // idempotency 409 — never an unmapped error swallowing a real failure.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(IdempotencyConflictError);
    }

    // The actual crown-jewel guarantee: every successful outcome is a
    // REPLAY of the same reservation, never a second, distinct one.
    // `Promise.allSettled` doesn't guarantee the 10 calls issue their
    // first query at the same instant — under a loaded runner, an early
    // winner can fully complete (claim -> lock -> insert -> mark
    // "completed") before a late arrival even claims, so the late call
    // legitimately sees "completed" and replays its cached response
    // instead of "in_flight". That shows up as more than one fulfilled
    // outcome, which is correct idempotent behaviour, not a double
    // booking — so assert on WHICH reservation each outcome got, not on
    // exactly how many of the 10 happened to land in that window.
    const reservationIds = new Set(fulfilled.map((outcome) => outcome.value.reservationId));
    expect(reservationIds.size).toBe(1);

    const { rows } = await db.shardPools.pools[0].query<{ count: string }>(
      'SELECT count(*) FROM reservations WHERE event_id = $1 AND queue_token_id = $2',
      [eventId, queueTokenId],
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);
});
