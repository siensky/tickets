import { SalesClosedError, SalesNotOpenError } from '@tickets/domain';
import { createQueueTokenSecret, verifyQueueToken } from '@tickets/auth';
import type { ShardPools } from '@tickets/db';
import type { BusinessMetrics } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  getQueueStatus,
  joinQueue,
  queueTokenTtlSeconds,
} from '../../src/services/queue-service.js';

const SECRET = createQueueTokenSecret('unit-test-secret-at-least-32-bytes!!');

function fakeBusinessMetrics(): BusinessMetrics {
  const counter = { inc: vi.fn() };
  const gauge = { set: vi.fn(), reset: vi.fn() };
  return {
    activeReservations: gauge,
    soldTickets: gauge,
    waitingRoomDepth: gauge,
    queueJoinsTotal: counter,
    queueAdmissionsTotal: counter,
  } as unknown as BusinessMetrics;
}

function fakeShardPools(
  salesWindow: { salesOpenAt: Date; salesCloseAt: Date },
  soldOut = false,
): ShardPools {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM seats')) {
      return Promise.resolve({ rows: [{ sold_out: soldOut }] });
    }
    if (sql.includes('FROM events')) {
      // Emulerar Postgres `now()` (`db_now`, se events-repository.ts): öppet/stängt räknas från den
      // tiden, aldrig från appserverns klocka (docs/rules.md §4).
      return Promise.resolve({
        rows: [
          {
            sales_open_at: salesWindow.salesOpenAt,
            sales_close_at: salesWindow.salesCloseAt,
            db_now: new Date(),
          },
        ],
      });
    }
    // config lookup (getQueueConfig) — same keys every time.
    return Promise.resolve({
      rows: [
        { key: 'queue_admission_rate_per_minute', value: '300' },
        { key: 'queue_session_inactivity_minutes', value: '10' },
        { key: 'queue_direct_admit_limit', value: '1000' },
        { key: 'queue_booking_window_minutes', value: '10' },
      ],
    });
  });
  const pool = { query } as unknown as Pool;
  return { pools: [pool, pool] };
}

// Varje mock-fn returneras SEPARAT i stället för att läsas tillbaka
// från det typade `redis`-objektet i assertions — annars flaggar
// @typescript-eslint/unbound-method det som en potentiellt obunden
// metodreferens (samma mönster som shared/db:s egna testfejker, se
// transaction.test.ts).
/** `get` används både av config-cachen och av förnyelsen: bara `admitted:*` ska få ett slutdatum. */
function getReturningDeadline(deadlineMs: number): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation((key: string) =>
      Promise.resolve(key.startsWith('admitted:') ? String(deadlineMs) : null),
    );
}

function fakeRedis(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): {
  redis: RedisClient;
  zadd: ReturnType<typeof vi.fn>;
  evalScript: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  zrank: ReturnType<typeof vi.fn>;
  zcard: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
} {
  const fns = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    zadd: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    zrank: vi.fn().mockResolvedValue(null),
    zcard: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
  return { redis: fns as unknown as RedisClient, ...fns, evalScript: fns.eval };
}

describe('joinQueue', () => {
  it('issues a token scoped to the event and lets the atomic script decide queue or direct admit', async () => {
    const now = new Date();
    const shardPools = fakeShardPools({
      salesOpenAt: new Date(now.getTime() - 60_000),
      salesCloseAt: new Date(now.getTime() + 60_000),
    });
    const { redis, evalScript } = fakeRedis();

    const result = await joinQueue(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      { eventId: 'event-1' },
    );

    expect(result.eventId).toBe('event-1');
    const verified = await verifyQueueToken(SECRET, result.token);
    expect(verified).toMatchObject({ kind: 'valid', eventId: 'event-1' });
    // KEYS: kö, insläppsindex, admitted-nyckel, aktiva event. ARGV: token, nu, gräns (1000), TTL (10 min), event, insläppets slutdatum.
    expect(evalScript).toHaveBeenCalledWith(
      expect.any(String),
      4,
      'waitingroom:event-1',
      'admitted-index:event-1',
      expect.stringMatching(/^admitted:event-1:/),
      'waitingroom:active-events',
      expect.any(String),
      expect.any(Number),
      1000,
      600,
      'event-1',
      expect.any(Number),
    );
  });

  it('lets the token live until sales close, plus the booking window and a late checkout', async () => {
    const now = new Date();
    const shardPools = fakeShardPools({
      salesOpenAt: new Date(now.getTime() - 60_000),
      salesCloseAt: new Date(now.getTime() + 2 * 60 * 60_000),
    });
    const { redis } = fakeRedis();

    const { token } = await joinQueue(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      { eventId: 'event-1' },
    );

    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { iat: number; exp: number };
    // 2 h kvar av försäljningen + 10 min bokningsfönster + 15 min för håll och betalningsfrysning.
    // `iat` avrundas nedåt till hela sekunder, så tillåt en sekunds glapp.
    const expected = (120 + 10 + 15) * 60;
    expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(expected);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(expected + 1);
  });

  it('rejects joining before sales_open_at', async () => {
    const now = new Date();
    const shardPools = fakeShardPools({
      salesOpenAt: new Date(now.getTime() + 60_000),
      salesCloseAt: new Date(now.getTime() + 120_000),
    });
    const { redis } = fakeRedis();

    await expect(
      joinQueue(
        {
          shardPools,
          redis,
          queueTokenSecret: SECRET,
          businessMetrics: fakeBusinessMetrics(),
        },
        { eventId: 'event-1' },
      ),
    ).rejects.toThrow(SalesNotOpenError);
  });

  it('rejects joining after sales_close_at', async () => {
    const now = new Date();
    const shardPools = fakeShardPools({
      salesOpenAt: new Date(now.getTime() - 120_000),
      salesCloseAt: new Date(now.getTime() - 60_000),
    });
    const { redis } = fakeRedis();

    await expect(
      joinQueue(
        {
          shardPools,
          redis,
          queueTokenSecret: SECRET,
          businessMetrics: fakeBusinessMetrics(),
        },
        { eventId: 'event-1' },
      ),
    ).rejects.toThrow(SalesClosedError);
  });
});

describe('getQueueStatus', () => {
  const shardPools = fakeShardPools({
    salesOpenAt: new Date(Date.now() - 60_000),
    salesCloseAt: new Date(Date.now() + 60_000),
  });

  it('reports "admitted" and refreshes the inactivity TTL', async () => {
    const { redis, expire } = fakeRedis({
      exists: vi.fn().mockResolvedValue(1),
      get: getReturningDeadline(Date.now() + 30 * 60_000),
    });

    const status = await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'token-1',
    );

    expect(status).toEqual({ status: 'admitted' });
    expect(expire).toHaveBeenCalledWith('admitted:event-1:token-1', 600);
  });

  it('never renews an admitted session past the end of its booking window', async () => {
    const { redis, expire } = fakeRedis({
      exists: vi.fn().mockResolvedValue(1),
      get: getReturningDeadline(Date.now() + 30_000),
    });

    await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'token-1',
    );

    const [key, ttl] = expire.mock.calls[0] as [string, number];
    expect(key).toBe('admitted:event-1:token-1');
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('reports "waiting" with position and queue depth', async () => {
    const { redis } = fakeRedis({
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(3),
      zcard: vi.fn().mockResolvedValue(4823),
    });

    const status = await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'token-1',
    );

    // Tom config-cache: golvet, utan att fråga databasen.
    expect(status).toEqual({
      status: 'waiting',
      position: 4,
      queueDepth: 4823,
      nextPollSeconds: 5,
    });
  });

  it('räknar pollningsintervallet från insläppstakten i cachen, aldrig från databasen', async () => {
    const { redis } = fakeRedis({
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(4799),
      zcard: vi.fn().mockResolvedValue(9000),
      get: vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(key === 'config:queue_admission_rate_per_minute' ? '3600' : null),
        ),
    });
    const { query } = shardPools.pools[0] as unknown as { query: ReturnType<typeof vi.fn> };
    query.mockClear();

    const status = await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'token-1',
    );

    // 3600/min = 60/s: plats 4 800 är framme om 80 s, alltså fråga om 20 s.
    expect(status).toMatchObject({ status: 'waiting', position: 4800, nextPollSeconds: 20 });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports "not_found" for an unknown token', async () => {
    const { redis } = fakeRedis({
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(null),
    });

    const status = await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'ghost',
    );

    expect(status).toEqual({ status: 'not_found' });
  });

  it('reports "sales_closed" instead of "not_found" once the sales window has closed', async () => {
    const closedShardPools = fakeShardPools({
      salesOpenAt: new Date(Date.now() - 120_000),
      salesCloseAt: new Date(Date.now() - 60_000),
    });
    const { redis } = fakeRedis({
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(null),
    });

    const status = await getQueueStatus(
      {
        shardPools: closedShardPools,
        redis,
        queueTokenSecret: SECRET,
        businessMetrics: fakeBusinessMetrics(),
      },
      'event-1',
      'ghost',
    );

    expect(status).toEqual({ status: 'sales_closed' });
  });

  it('reports "sold_out" once the queue was drained because no seat can be had', async () => {
    const soldOutShardPools = fakeShardPools(
      {
        salesOpenAt: new Date(Date.now() - 60_000),
        salesCloseAt: new Date(Date.now() + 60_000),
      },
      true,
    );
    const { redis } = fakeRedis({
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(null),
    });

    const status = await getQueueStatus(
      {
        shardPools: soldOutShardPools,
        redis,
        queueTokenSecret: SECRET,
        businessMetrics: fakeBusinessMetrics(),
      },
      'event-1',
      'ghost',
    );

    expect(status).toEqual({ status: 'sold_out' });
  });
});

describe('queueTokenTtlSeconds', () => {
  it('covers the rest of the sale, the booking window and the reservation tail', () => {
    const config = {
      admissionRatePerMinute: 300,
      sessionInactivityMinutes: 10,
      directAdmitLimit: 1000,
      bookingWindowMinutes: 12,
    };

    expect(queueTokenTtlSeconds(config, 3600)).toBe(3600 + (12 + 15) * 60);
  });
});
