import type { ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@tickets/domain';
import {
  getSectionSeatStatusBody,
  getSectionSummaryBody,
} from '../../src/services/seatmap-service.js';

const SILENT_LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const SEAT_ROW = {
  id: 'seat-1',
  venue_seat_id: 'venue-seat-1',
  status: 'available',
  price_cents: 1000,
};

const EXPECTED_BODY = JSON.stringify({
  seats: [
    {
      seatId: 'seat-1',
      venueSeatId: 'venue-seat-1',
      status: 'available',
      priceCents: 1000,
      heldUntil: null,
    },
  ],
});

function fakePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [SEAT_ROW] });
  return { pool: { query } as unknown as Pool, query };
}

function fakeShardPools(pool: Pool): ShardPools {
  return { pools: [pool, pool] };
}

describe('getSectionSeatStatusBody', () => {
  it('falls back to Postgres and still returns a result when the Redis read fails', async () => {
    const { pool } = fakePool();
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as RedisClient;

    const body = await getSectionSeatStatusBody(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    expect(body).toBe(EXPECTED_BODY);
  });

  it('still returns the freshly-read result when the Redis write fails', async () => {
    const { pool } = fakePool();
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as RedisClient;

    const body = await getSectionSeatStatusBody(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    expect(body).toBe(EXPECTED_BODY);
  });

  it('caches the finished body and sends a cached body unchanged, without touching Postgres', async () => {
    const { pool, query } = fakePool();
    const set = vi.fn().mockResolvedValue('OK');
    const redis = {
      get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(EXPECTED_BODY),
      set,
    } as unknown as RedisClient;
    const deps = { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER };

    await getSectionSeatStatusBody(deps, 'event-1', 'section-1');
    const cached = await getSectionSeatStatusBody(deps, 'event-1', 'section-1');

    expect(set).toHaveBeenCalledWith('seatmap:v2:event-1:section-1', EXPECTED_BODY, 'EX', 2);
    expect(cached).toBe(EXPECTED_BODY);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('ger heldUntil som ISO-tid för en upptagen stol och null annars', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            ...SEAT_ROW,
            id: 'a',
            status: 'held',
            held_until: new Date('2030-01-01T12:05:00Z'),
          },
          { ...SEAT_ROW, id: 'b', status: 'available', held_until: null },
        ],
      }),
    } as unknown as Pool;
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as RedisClient;

    const body = await getSectionSeatStatusBody(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    const parsed: unknown = JSON.parse(body);
    expect(parsed).toMatchObject({
      seats: [{ heldUntil: '2030-01-01T12:05:00.000Z' }, { heldUntil: null }],
    });
  });
});

describe('getSectionSeatStatusBody: katalogens version', () => {
  const CACHED_CATALOG = '{"version":"aaaaaaaaaaaaaaaa","seats":[]}';

  function depsWithCachedCatalog() {
    const { pool, query } = fakePool();
    const redis = {
      get: vi.fn().mockResolvedValue(CACHED_CATALOG),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as RedisClient;
    return { deps: { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER }, query };
  }

  it('använder den cachade katalogen när versionen stämmer', async () => {
    const { deps, query } = depsWithCachedCatalog();

    const body = await getSectionSeatStatusBody(
      deps,
      'event-1',
      'section-1',
      'catalog',
      'aaaaaaaaaaaaaaaa',
    );

    expect(body).toBe(CACHED_CATALOG);
    expect(query).not.toHaveBeenCalled();
  });

  it('läser om från Postgres när den cachade katalogen har en annan version', async () => {
    const { deps, query } = depsWithCachedCatalog();

    const body = await getSectionSeatStatusBody(
      deps,
      'event-1',
      'section-1',
      'catalog',
      'bbbbbbbbbbbbbbbb',
    );

    expect(query).toHaveBeenCalledOnce();
    expect(JSON.parse(body)).toMatchObject({
      seats: [{ seatId: 'seat-1', venueSeatId: 'venue-seat-1', priceCents: 1000 }],
    });
  });
});

describe('getSectionSummaryBody', () => {
  function unknownEventDeps(summaryCacheSeconds: number) {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    const get = vi.fn().mockResolvedValue(null);
    const set = vi.fn().mockResolvedValue('OK');
    const redis = { get, set } as unknown as RedisClient;
    return {
      deps: {
        shardPools: fakeShardPools(pool),
        redis,
        logger: SILENT_LOGGER,
        summaryCacheSeconds,
      },
      get,
      set,
    };
  }

  it('rör inte Redis när API-cachen är avstängd (0)', async () => {
    const { deps, get, set } = unknownEventDeps(0);

    await expect(getSectionSummaryBody(deps, 'event-1')).rejects.toBeInstanceOf(NotFoundError);

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('cachar aldrig ett 404 för ett okänt event', async () => {
    const { deps, get, set } = unknownEventDeps(5);

    await expect(getSectionSummaryBody(deps, 'event-1')).rejects.toBeInstanceOf(NotFoundError);

    expect(get).toHaveBeenCalledWith('seatmap-summary:v1:event-1');
    expect(set).not.toHaveBeenCalled();
  });
});
