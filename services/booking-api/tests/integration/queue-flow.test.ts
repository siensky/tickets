/**
 * End-to-end väntrum → reservation mot RIKTIGA Postgres- och
 * Redis-containrar (docs/rules.md §8: inga mockade databaser i
 * integrationstester). Simulerar scheduler-workers insläppsjobb genom
 * att anropa `admitNextBatch` direkt (dess egen periodiska timer har
 * sitt eget enhetstest i scheduler-worker) — det här testet bevisar
 * kontraktet mellan booking-api och Redis-primitiverna, inte timer-
 * schemaläggningen.
 */
import { randomUUID } from 'node:crypto';
import { createQueueTokenSecret } from '@tickets/auth';
import { ActiveReservationExistsError, QueueTokenNotAdmittedError } from '@tickets/domain';
import { createBusinessMetrics, createRegistry, type Logger } from '@tickets/observability';
import { admitNextBatch, configCacheKey } from '@tickets/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateQueueToken } from '../../src/services/queue-auth-service.js';
import { getQueueStatus, joinQueue } from '../../src/services/queue-service.js';
import { reserveSeats } from '../../src/services/reservation-service.js';
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

const SECRET = createQueueTokenSecret('integration-test-secret-at-least-32-bytes!!');
const BUSINESS_METRICS = createBusinessMetrics(createRegistry('test'));
// test-helpers.ts:s SILENT_LOGGER är typad löst (node-pg-migrate:s egen
// loggertyp) — authenticateQueueToken kräver pino:s striktare `Logger`.
const QUEUE_AUTH_LOGGER = SILENT_LOGGER as unknown as Logger;

describe('queue → reservation flow', () => {
  let db: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  /** Sätter direktinsläppsgränsen i `config` och tömmer Redis-cachen (annars gäller det gamla värdet i 5 s). */
  async function setDirectAdmitLimit(limit: number): Promise<void> {
    await db.shardPools.pools[0].query(
      `UPDATE config SET value = $1 WHERE key = 'queue_direct_admit_limit'`,
      [String(limit)],
    );
    await redis.client.del(configCacheKey('queue_direct_admit_limit'));
  }

  function queueDeps(): Parameters<typeof joinQueue>[0] & { logger: Logger } {
    return {
      shardPools: db.shardPools,
      redis: redis.client,
      queueTokenSecret: SECRET,
      logger: QUEUE_AUTH_LOGGER,
      businessMetrics: BUSINESS_METRICS,
    };
  }

  async function join(eventId: string): Promise<string> {
    const deps = queueDeps();
    const joined = await joinQueue(deps, { eventId });
    const auth = await authenticateQueueToken(deps, joined.token);
    if (auth.kind !== 'valid') {
      throw new Error('expected a valid token');
    }
    return auth.queueTokenId;
  }

  it('släpper in direkt när kön är tom och gränsen inte är nådd', async () => {
    await setDirectAdmitLimit(1000);
    const eventId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [randomUUID()] });

    const queueTokenId = await join(eventId);

    expect(await getQueueStatus(queueDeps(), eventId, queueTokenId)).toEqual({
      status: 'admitted',
    });
  }, 60_000);

  it('ställer joinare i kö när gränsen är nådd, och behåller FIFO även när plats frigörs', async () => {
    await setDirectAdmitLimit(2);
    const eventId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [randomUUID()] });

    const first = await join(eventId);
    const second = await join(eventId);
    const third = await join(eventId);
    expect(await getQueueStatus(queueDeps(), eventId, first)).toEqual({ status: 'admitted' });
    expect(await getQueueStatus(queueDeps(), eventId, second)).toEqual({ status: 'admitted' });
    expect(await getQueueStatus(queueDeps(), eventId, third)).toMatchObject({
      status: 'waiting',
      position: 1,
    });

    // Gränsen höjs, men kön är inte tom: nästa joinare ställs sig bakom den väntande.
    await setDirectAdmitLimit(10);
    const fourth = await join(eventId);
    expect(await getQueueStatus(queueDeps(), eventId, fourth)).toMatchObject({
      status: 'waiting',
      position: 2,
    });
  }, 60_000);

  it('räknar bara insläppta vars insläpp inte löpt ut, och gräns 0 betyder att alla köar', async () => {
    await setDirectAdmitLimit(1);
    const eventId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [randomUUID()] });
    const first = await join(eventId);
    expect(await getQueueStatus(queueDeps(), eventId, first)).toEqual({ status: 'admitted' });

    // Insläppet löper ut: indexet har score = utgångstid, så ett passerat värde frigör platsen.
    await redis.client.zadd(`admitted-index:${eventId}`, 0, first);
    const second = await join(eventId);
    expect(await getQueueStatus(queueDeps(), eventId, second)).toEqual({ status: 'admitted' });

    await setDirectAdmitLimit(0);
    const third = await join(eventId);
    expect(await getQueueStatus(queueDeps(), eventId, third)).toMatchObject({
      status: 'waiting',
    });
  }, 60_000);

  it('blocks reservation until admitted, then lets the admitted token reserve seats', async () => {
    await setDirectAdmitLimit(0);
    const eventId = randomUUID();
    const seatId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [seatId] });
    const deps = {
      shardPools: db.shardPools,
      redis: redis.client,
      queueTokenSecret: SECRET,
      logger: QUEUE_AUTH_LOGGER,
      businessMetrics: BUSINESS_METRICS,
    };

    const joined = await joinQueue(deps, { eventId });
    const auth = await authenticateQueueToken(deps, joined.token);
    if (auth.kind !== 'valid') {
      throw new Error('expected a valid token');
    }

    expect(await getQueueStatus(deps, eventId, auth.queueTokenId)).toMatchObject({
      status: 'waiting',
    });

    await expect(
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatId],
        queueTokenId: auth.queueTokenId,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toBeDefined();
    // reserveSeats itself has no admission check (that's the route
    // preHandler's job, docs/rules.md §1 keeps it out of services) —
    // this test instead proves the ADMISSION STATE TRANSITION below,
    // which is what the preHandler actually reads.
    expect(await getQueueStatus(deps, eventId, auth.queueTokenId)).toMatchObject({
      status: 'waiting',
    });

    const admission = await admitNextBatch(redis.client, eventId, 10, 600, 15);
    expect(admission.admittedQueueTokenIds).toContain(auth.queueTokenId);
    expect(await getQueueStatus(deps, eventId, auth.queueTokenId)).toEqual({
      status: 'admitted',
    });
  }, 60_000);

  it('rejects a second reservation attempt for the same already-reserved queue token', async () => {
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID()];
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds });
    const queueTokenId = randomUUID();

    await reserveSeats(db.shardPools, {
      eventId,
      seatIds: [seatIds[0] as string],
      queueTokenId,
      idempotencyKey: randomUUID(),
    });

    await expect(
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatIds[1] as string],
        queueTokenId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ActiveReservationExistsError);
  }, 60_000);

  it('QueueTokenNotAdmittedError carries the queue token id for the error response context', () => {
    const error = new QueueTokenNotAdmittedError('token-123');
    expect(error.context).toEqual({ queueTokenId: 'token-123' });
    expect(error.httpStatus).toBe(403);
  });
});
