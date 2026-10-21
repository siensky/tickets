/**
 * Crown-jewel test #1 (docs/plan.md "Tester"): 100 parallel attempts on
 * the same seat → exactly 1 succeeds, 99 get a clean error response.
 * Proves `FOR UPDATE NOWAIT` plus the all-or-nothing transaction
 * actually serializes contention instead of overselling it.
 */
import { randomUUID } from 'node:crypto';
import { SeatUnavailableError } from '@tickets/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  getSeatStatuses,
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

describe('reservation race (crown jewel #1)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('lets exactly one of 100 concurrent attempts win the contested seat', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [seatId] });

    const attempts = Array.from({ length: 100 }, () =>
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatId],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    const outcomes = await Promise.allSettled(attempts);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(SeatUnavailableError);
    }

    const statuses = await getSeatStatuses(db.shardPools.pools[0], [seatId]);
    expect(statuses.get(seatId)).toBe('held');
  }, 60_000);
});
