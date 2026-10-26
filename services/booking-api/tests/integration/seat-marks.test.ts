/**
 * Stolmarkering + "din stol togs" mot en RIKTIG Redis-container
 * (docs/rules.md §8) och den riktiga reservationstransaktionen mot
 * Postgres — bevisar hela kedjan: A markerar en stol, B reserverar den,
 * A får ett "seat_taken"-meddelande på sin WS-kanal, och A:s markering
 * städas bort.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@tickets/observability';
import { getMarkedSeats, subscribeToChannel, wsChannel } from '@tickets/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  markSeat,
  notifySeatsTaken,
  unmarkSeat,
} from '../../src/services/seat-mark-service.js';
import {
  seedEventWithSeats,
  SILENT_LOGGER,
  startTestDatabase,
  startTestRedis,
  stopTestDatabase,
  stopTestRedis,
  type TestDatabase,
  type TestRedis,
} from './test-helpers.js';

const LOGGER = SILENT_LOGGER as unknown as Logger;

describe('seat marking', () => {
  let db: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  it('marks and unmarks a seat for a queue token', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    const queueTokenId = randomUUID();
    const deps = { redis: redis.client, logger: LOGGER };

    await markSeat(deps, { eventId, queueTokenId, seatId });
    expect(await getMarkedSeats(redis.client, queueTokenId)).toEqual([seatId]);

    await unmarkSeat(deps, { eventId, queueTokenId, seatId });
    expect(await getMarkedSeats(redis.client, queueTokenId)).toEqual([]);
  }, 30_000);

  it('notifies another holder that their marked seat was taken, and clears their mark', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    const markingQueueTokenId = randomUUID();
    const takingQueueTokenId = randomUUID();
    const deps = { redis: redis.client, logger: LOGGER };

    await markSeat(deps, { eventId, queueTokenId: markingQueueTokenId, seatId });

    const received: unknown[] = [];
    const subscription = await subscribeToChannel(
      redis.client,
      wsChannel(markingQueueTokenId),
      (payload) => received.push(payload),
    );

    await notifySeatsTaken(deps, {
      eventId,
      seatIds: [seatId],
      takenByQueueTokenId: takingQueueTokenId,
    });

    await waitForCondition(() => received.length > 0);
    expect(received).toEqual([{ type: 'seat_taken', seatId }]);
    expect(await getMarkedSeats(redis.client, markingQueueTokenId)).toEqual([]);

    await subscription.unsubscribe();
  }, 30_000);

  it('never notifies the queue token that itself just took the seat', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    const takingQueueTokenId = randomUUID();
    const deps = { redis: redis.client, logger: LOGGER };

    await markSeat(deps, { eventId, queueTokenId: takingQueueTokenId, seatId });

    const received: unknown[] = [];
    const subscription = await subscribeToChannel(
      redis.client,
      wsChannel(takingQueueTokenId),
      (payload) => received.push(payload),
    );

    // notifySeatsTaken filters the taker out BEFORE publishing (never
    // after), so by the time this resolves every publish it was ever
    // going to make has already completed — no timing window to wait
    // out, unlike the positive case above.
    await notifySeatsTaken(deps, {
      eventId,
      seatIds: [seatId],
      takenByQueueTokenId: takingQueueTokenId,
    });
    expect(received).toEqual([]);

    await subscription.unsubscribe();
  }, 30_000);

  it('runs as a side-effect of a real reservation without failing it, even with no markers', async () => {
    const eventId = randomUUID();
    const seatId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [seatId] });

    const result = await reserveSeats(db.shardPools, {
      eventId,
      seatIds: [seatId],
      queueTokenId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    await expect(
      notifySeatsTaken(
        { redis: redis.client, logger: LOGGER },
        { eventId, seatIds: result.seatIds, takenByQueueTokenId: result.queueTokenId },
      ),
    ).resolves.toBeUndefined();
  }, 60_000);
});

/** Short polling wait — docs/rules.md §8 forbids a plain `sleep`, the condition must be awaited. */
async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
