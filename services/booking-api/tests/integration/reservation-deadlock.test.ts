/**
 * Crown-jewel test #2 (docs/plan.md "Tester"): requesting seats [A, B]
 * and [B, A] at the same time must not deadlock — "båda slutförs,
 * ingen deadlock" (both COMPLETE, no deadlock), not "both succeed":
 * they're contesting the identical pair, so exactly one can actually
 * win the seats.
 *
 * Locking each seat individually in sorted order (reservation-repository.ts)
 * means this never reaches Postgres's own deadlock detector in the
 * first place — the loser's `NOWAIT` fails immediately on the first
 * contended seat instead of blocking, so there's nothing to deadlock
 * on. That's a feature, not a test gap: the system is built to avoid
 * ever taking a blocking wait in this path. See
 * reservation-cross-seat-expiry.test.ts for the ABBA scenario that
 * *did* used to deadlock for real (two different seats of the same
 * stale reservation, which blocking cross-table writes made possible).
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
