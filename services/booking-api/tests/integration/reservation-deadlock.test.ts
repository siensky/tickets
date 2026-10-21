/**
 * Crown-jewel test #2 (docs/plan.md "Tester"): requesting seats [A, B]
 * and [B, A] at the same time must not deadlock. `ORDER BY id` before
 * `FOR UPDATE` in the seat lock query is what makes both transactions
 * always acquire the two rows in the same order regardless of the
 * order the caller listed them in.
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

describe('reservation deadlock (crown jewel #2)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('both attempts finish — no deadlock — when seat order is reversed between them', async () => {
    const eventId = randomUUID();
    const seatA = randomUUID();
    const seatB = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [seatA, seatB] });

    const [outcomeAB, outcomeBA] = await Promise.allSettled([
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatA, seatB],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatB, seatA],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ]);

    // Both settle (fulfilled or rejected) — the point of this test is
    // that neither hangs and neither surfaces Postgres's own
    // deadlock_detected (40P01) as a raw, unmapped error. They contest
    // the same pair of seats, so exactly one of the two wins; which one
    // is incidental.
    const results = [outcomeAB, outcomeBA];
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(SeatUnavailableError);

    const statuses = await getSeatStatuses(db.shardPools.pools[0], [seatA, seatB]);
    expect(statuses.get(seatA)).toBe('held');
    expect(statuses.get(seatB)).toBe('held');
  }, 60_000);
});
