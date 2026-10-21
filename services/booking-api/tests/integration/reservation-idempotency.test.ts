/**
 * Crown-jewel test #3 (docs/plan.md "Tester"): the same idempotency key
 * fired 10 times in parallel → 1×success + 9×409, and exactly one
 * reservation row — never an empty response for the 9 concurrent
 * retries that arrive while the winner is still running.
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
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(IdempotencyConflictError);
    }

    const { rows } = await db.shardPools.pools[0].query<{ count: string }>(
      'SELECT count(*) FROM reservations WHERE event_id = $1 AND queue_token_id = $2',
      [eventId, queueTokenId],
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);
});
