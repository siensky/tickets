import { SalesClosedError, SalesNotOpenError } from '@tickets/domain';
import { createQueueTokenSecret, verifyQueueToken } from '@tickets/auth';
import type { ShardPools } from '@tickets/db';
import type { BusinessMetrics } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getQueueStatus, joinQueue } from '../../src/services/queue-service.js';

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

function fakeShardPools(salesWindow: { salesOpenAt: Date; salesCloseAt: Date }): ShardPools {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM events')) {
      // Emulerar vad Postgres SJÄLV skulle räkna ut (`now() < sales_open_at`
      // osv, se events-repository.ts) — testets `pool.query` är en fejk
      // som inte kör riktig SQL, så den måste räkna ut samma booleaner
      // som produktionskoden numera litar på i stället för appserverns
      // `new Date()` (docs/rules.md §4).
      const now = new Date();
      return Promise.resolve({
        rows: [
          {
            sales_open_at: salesWindow.salesOpenAt,
            sales_close_at: salesWindow.salesCloseAt,
            is_before_open: now < salesWindow.salesOpenAt,
            is_after_close: now > salesWindow.salesCloseAt,
          },
        ],
      });
    }
    // config lookup (getQueueConfig) — same three keys every time.
    return Promise.resolve({
      rows: [
        { key: 'queue_admission_rate_per_minute', value: '300' },
        { key: 'queue_session_total_minutes', value: '15' },
        { key: 'queue_session_inactivity_minutes', value: '10' },
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
function fakeRedis(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): {
  redis: RedisClient;
  zadd: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  zrank: ReturnType<typeof vi.fn>;
  zcard: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
} {
  const fns = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    zadd: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
    zrank: vi.fn().mockResolvedValue(null),
    zcard: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
  return { redis: fns as unknown as RedisClient, ...fns };
}

describe('joinQueue', () => {
  it('issues a token scoped to the event and adds it to the waiting-room ZSET', async () => {
    const now = new Date();
    const shardPools = fakeShardPools({
      salesOpenAt: new Date(now.getTime() - 60_000),
      salesCloseAt: new Date(now.getTime() + 60_000),
    });
    const { redis, zadd } = fakeRedis();

    const result = await joinQueue(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      { eventId: 'event-1' },
    );

    expect(result.eventId).toBe('event-1');
    const verified = await verifyQueueToken(SECRET, result.token);
    expect(verified).toMatchObject({ kind: 'valid', eventId: 'event-1' });
    expect(zadd).toHaveBeenCalledWith(
      'waitingroom:event-1',
      expect.any(Number),
      expect.any(String),
    );
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
    const { redis, expire } = fakeRedis({ exists: vi.fn().mockResolvedValue(1) });

    const status = await getQueueStatus(
      { shardPools, redis, queueTokenSecret: SECRET, businessMetrics: fakeBusinessMetrics() },
      'event-1',
      'token-1',
    );

    expect(status).toEqual({ status: 'admitted' });
    expect(expire).toHaveBeenCalledWith('admitted:event-1:token-1', 600);
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

    expect(status).toEqual({ status: 'waiting', position: 4, queueDepth: 4823 });
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
});
