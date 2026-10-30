import type { ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { getSectionSeatStatus } from '../../src/services/seatmap-service.js';

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

function fakePool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [SEAT_ROW] }) } as unknown as Pool;
}

function fakeShardPools(pool: Pool): ShardPools {
  return { pools: [pool, pool] };
}

describe('getSectionSeatStatus', () => {
  it('falls back to Postgres and still returns a result when the Redis read fails', async () => {
    const pool = fakePool();
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as RedisClient;

    const result = await getSectionSeatStatus(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    expect(result).toEqual([
      { seatId: 'seat-1', venueSeatId: 'venue-seat-1', status: 'available', priceCents: 1000 },
    ]);
  });

  it('still returns the freshly-read result when the Redis write fails', async () => {
    const pool = fakePool();
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as RedisClient;

    const result = await getSectionSeatStatus(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    expect(result).toEqual([
      { seatId: 'seat-1', venueSeatId: 'venue-seat-1', status: 'available', priceCents: 1000 },
    ]);
  });

  it('behandlar en cachepost utan priceCents (skriven av en äldre podd) som cachemiss', async () => {
    const pool = fakePool();
    const stale = JSON.stringify([
      { seatId: 'seat-1', venueSeatId: 'venue-seat-1', status: 'held' },
    ]);
    const redis = {
      get: vi.fn().mockResolvedValue(stale),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as RedisClient;

    const result = await getSectionSeatStatus(
      { shardPools: fakeShardPools(pool), redis, logger: SILENT_LOGGER },
      'event-1',
      'section-1',
    );

    expect(result[0]?.priceCents).toBe(1000);
  });
});
