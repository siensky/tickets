/**
 * Insläppsjobbet mot RIKTIGA Postgres- och Redis-containrar (docs/rules.md
 * §8). Kör en manuell tick (ingen `setInterval`-väntan) via att starta
 * jobbet med ett kort intervall och polla tills den hunnit köra, och
 * stoppar den direkt igen — vi testar en TICKS beteende, inte timerns
 * egen schemaläggning (det har reservation-release-service redan).
 */
import { randomUUID } from 'node:crypto';
import { admittedKey, joinWaitingRoom, subscribeToChannel, wsChannel } from '@tickets/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBusinessMetrics, createLogger, createRegistry } from '@tickets/observability';
import { startQueueAdmissionJob } from '../../src/services/queue-admission-service.js';
import {
  seedEvent,
  startTestInfra,
  startTestRedis,
  stopTestInfra,
  stopTestRedis,
  waitFor,
  type TestInfra,
  type TestRedis,
} from './test-helpers.js';

const logger = createLogger({ serviceName: 'test' });
const businessMetrics = createBusinessMetrics(createRegistry('test'));

async function seedQueueConfig(
  infra: TestInfra,
  admissionRatePerMinute: number,
  sessionInactivityMinutes: number,
): Promise<void> {
  await infra.shardPools.pools[0].query(
    `INSERT INTO config (key, value) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      'queue_admission_rate_per_minute',
      String(admissionRatePerMinute),
      'queue_session_inactivity_minutes',
      String(sessionInactivityMinutes),
    ],
  );
}

async function seedSeats(
  infra: TestInfra,
  eventId: string,
  statuses: readonly string[],
): Promise<void> {
  for (const [index, status] of statuses.entries()) {
    await infra.shardPools.pools[0].query(
      `INSERT INTO seats (event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents, status)
       VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'A', $2, $3, 50000, $4)`,
      [eventId, index + 1, `T-${index + 1}`, status],
    );
  }
}

/** Startar jobbet, väntar tills `token` fått sitt första meddelande och returnerar det. */
async function firstMessageAfterTick(
  infra: TestInfra,
  redis: TestRedis,
  token: string,
): Promise<string> {
  const notified: string[] = [];
  const subscription = await subscribeToChannel(redis.client, wsChannel(token), (payload) => {
    notified.push(JSON.stringify(payload));
  });
  const job = startQueueAdmissionJob(
    infra.shardPools,
    redis.client,
    logger,
    businessMetrics,
    200,
  );
  try {
    await waitFor(() => Promise.resolve(notified.length > 0), {
      timeoutMs: 5000,
      intervalMs: 100,
    });
    return notified[0] ?? '';
  } finally {
    await job.stop();
    await subscription.unsubscribe();
  }
}

describe('queue admission job', () => {
  let infra: TestInfra;
  let redis: TestRedis;

  beforeAll(async () => {
    [infra, redis] = await Promise.all([startTestInfra(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestInfra(infra), stopTestRedis(redis)]);
  });

  it('admits the earliest arrivals first, up to the rate-derived batch size, and notifies them over pub/sub', async () => {
    const eventId = randomUUID();
    await seedEvent(infra, {
      eventId,
      salesOpenAt: new Date(Date.now() - 60_000),
      salesCloseAt: new Date(Date.now() + 60_000),
    });
    // Jobbet körs nedan med ett 200 ms-intervall (snabbare testkörning)
    // — 600/min över ett 200 ms-intervall = round(600 * 200 / 60000) = 2 per tick.
    await seedQueueConfig(infra, 600, 10);

    const tokens = ['first', 'second', 'third'];
    for (const token of tokens) {
      await joinWaitingRoom(redis.client, eventId, token);
      // Skild ankomsttid (ms-upplösning) — annars kan ZSET-ordningen
      // mellan likvärdiga scores bli odefinierad och testet flakey.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const notified: string[] = [];
    const subscription = await subscribeToChannel(
      redis.client,
      wsChannel('first'),
      (payload) => {
        notified.push(JSON.stringify(payload));
      },
    );

    const job = startQueueAdmissionJob(
      infra.shardPools,
      redis.client,
      logger,
      businessMetrics,
      200,
    );
    try {
      await waitFor(
        async () => (await redis.client.exists(admittedKey(eventId, 'first'))) === 1,
        {
          timeoutMs: 5000,
          intervalMs: 100,
        },
      );

      expect(await redis.client.exists(admittedKey(eventId, 'second'))).toBe(1);
      expect(await redis.client.exists(admittedKey(eventId, 'third'))).toBe(0);
      await waitFor(() => Promise.resolve(notified.length > 0), {
        timeoutMs: 2000,
        intervalMs: 50,
      });
      expect(notified[0]).toContain('admitted');
    } finally {
      await job.stop();
      await subscription.unsubscribe();
    }
  }, 30_000);

  it('drains the queue and leaves no one admitted once the sales window has closed', async () => {
    const eventId = randomUUID();
    await seedEvent(infra, {
      eventId,
      salesOpenAt: new Date(Date.now() - 120_000),
      salesCloseAt: new Date(Date.now() - 60_000),
    });
    await seedQueueConfig(infra, 300, 10);
    await joinWaitingRoom(redis.client, eventId, 'latecomer');

    const notified: string[] = [];
    const subscription = await subscribeToChannel(
      redis.client,
      wsChannel('latecomer'),
      (payload) => {
        notified.push(JSON.stringify(payload));
      },
    );

    const job = startQueueAdmissionJob(
      infra.shardPools,
      redis.client,
      logger,
      businessMetrics,
      200,
    );
    try {
      await waitFor(() => Promise.resolve(notified.length > 0), {
        timeoutMs: 5000,
        intervalMs: 100,
      });
      expect(notified[0]).toContain('sales_closed');
      expect(await redis.client.exists(admittedKey(eventId, 'latecomer'))).toBe(0);
    } finally {
      await job.stop();
      await subscription.unsubscribe();
    }
  }, 30_000);

  it('drains the queue with "sold_out" once every seat is sold, while the sale is still open', async () => {
    const eventId = randomUUID();
    await seedEvent(infra, {
      eventId,
      salesOpenAt: new Date(Date.now() - 60_000),
      salesCloseAt: new Date(Date.now() + 60 * 60_000),
    });
    await seedSeats(infra, eventId, ['sold', 'sold']);
    await seedQueueConfig(infra, 300, 10);
    await joinWaitingRoom(redis.client, eventId, 'too-late');

    const message = await firstMessageAfterTick(infra, redis, 'too-late');

    expect(message).toContain('sold_out');
    expect(await redis.client.exists(admittedKey(eventId, 'too-late'))).toBe(0);
  }, 30_000);

  it('keeps the queue moving while a held seat may still come back', async () => {
    const eventId = randomUUID();
    await seedEvent(infra, {
      eventId,
      salesOpenAt: new Date(Date.now() - 60_000),
      salesCloseAt: new Date(Date.now() + 60 * 60_000),
    });
    await seedSeats(infra, eventId, ['sold', 'held']);
    await seedQueueConfig(infra, 300, 10);
    await joinWaitingRoom(redis.client, eventId, 'hopeful');

    const message = await firstMessageAfterTick(infra, redis, 'hopeful');

    expect(message).toContain('admitted');
  }, 30_000);
});
