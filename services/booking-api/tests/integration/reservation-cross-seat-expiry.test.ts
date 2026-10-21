/**
 * Regression test for the ABBA deadlock an adversarial review found in
 * the original lazy-expiry implementation: two concurrent requests for
 * DIFFERENT seats of the SAME expired multi-seat reservation used to
 * deadlock, because releasing seat 1 also wrote seat 2 (blocking on
 * whoever held it) while the other request did the mirror image.
 *
 * The fix (docs/plan.md "Concurrency-kärnan") is that lazy expiry only
 * ever touches the seat a request actually locked itself, plus
 * (conditionally, by id, never by scanning another seat) the
 * reservation row once it has no held seats left — never a sibling
 * seat. That means both requests here succeed independently with no
 * contention at all, which is what this test proves. Whether the
 * original reservation ends up `expired` immediately or only after the
 * periodic release job's next pass depends on exact timing (see
 * reservation-repository.ts's doc comment) — both are correct, so this
 * only asserts the end state after simulating that job's own cleanup
 * statement, not which path got there.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  getSeatStatuses,
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

describe('lazy expiry across different seats of the same stale reservation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('releases both seats independently with no deadlock, then self-heals via the release job', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatA = randomUUID();
    const seatB = randomUUID();
    await seedEventWithSeats(pool, { eventId, seatIds: [seatA, seatB] });

    const original = await reserveSeats(db.shardPools, {
      eventId,
      seatIds: [seatA, seatB],
      queueTokenId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    await pool.query(
      "UPDATE reservations SET release_after = now() - interval '1 second' WHERE id = $1",
      [original.reservationId],
    );

    const outcomes = await Promise.allSettled([
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatA],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatB],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ]);

    // The whole point: both settle, and both succeed — unlike the
    // same-seat contention test, these two requests never compete for
    // anything, so there's no reason for either to fail.
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('fulfilled');
    }

    const statuses = await getSeatStatuses(pool, [seatA, seatB]);
    expect(statuses.get(seatA)).toBe('held');
    expect(statuses.get(seatB)).toBe('held');

    // The periodic release job's own statement (reservation-release-repository.ts)
    // is the authoritative backstop regardless of which of the two
    // requests, if either, already flipped the reservation itself —
    // simulated here without pulling scheduler-worker into
    // booking-api's tests.
    await pool.query(
      "UPDATE reservations SET status = 'expired' WHERE status = 'active' AND release_after < now()",
    );

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [original.reservationId],
    );
    expect(rows[0]?.status).toBe('expired');
  }, 60_000);
});
