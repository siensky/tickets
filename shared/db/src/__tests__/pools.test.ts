import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeShardPools,
  createShardPools,
  getGlobalPool,
  getPoolForEvent,
} from '../pools.js';
import { hashEventIdToShardIndex } from '../shard-router.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createShardPools', () => {
  it('throws when DATABASE_URL_SHARD_0 is missing', () => {
    delete process.env['DATABASE_URL_SHARD_0'];
    process.env['DATABASE_URL_SHARD_1'] = 'postgresql://fake-1';
    expect(() => createShardPools()).toThrow('DATABASE_URL_SHARD_0 must be set');
  });

  it('throws when DATABASE_URL_SHARD_1 is missing', () => {
    process.env['DATABASE_URL_SHARD_0'] = 'postgresql://fake-0';
    delete process.env['DATABASE_URL_SHARD_1'];
    expect(() => createShardPools()).toThrow('DATABASE_URL_SHARD_1 must be set');
  });
});

describe('getGlobalPool', () => {
  it('always returns shard 0, where users/venues/config live', () => {
    const shard0 = new Pool({ connectionString: 'postgresql://fake-0' });
    const shard1 = new Pool({ connectionString: 'postgresql://fake-1' });
    expect(getGlobalPool({ pools: [shard0, shard1] })).toBe(shard0);
  });
});

describe('getPoolForEvent', () => {
  it('routes to the pool matching hashEventIdToShardIndex', () => {
    const shard0 = new Pool({ connectionString: 'postgresql://fake-0' });
    const shard1 = new Pool({ connectionString: 'postgresql://fake-1' });
    const shardPools = { pools: [shard0, shard1] } as const;
    const eventId = randomUUID();
    const expectedShard = hashEventIdToShardIndex(eventId, 2) === 0 ? shard0 : shard1;
    expect(getPoolForEvent(shardPools, eventId)).toBe(expectedShard);
  });
});

describe('closeShardPools', () => {
  it('ends both pools', async () => {
    const shard0 = new Pool({ connectionString: 'postgresql://fake-0' });
    const shard1 = new Pool({ connectionString: 'postgresql://fake-1' });
    // Asserting on these local mocks, never on `shard0.end` itself —
    // reading a method off the typed Pool instance inside expect()
    // trips @typescript-eslint/unbound-method.
    const end0 = vi.fn().mockResolvedValue(undefined);
    const end1 = vi.fn().mockResolvedValue(undefined);
    shard0.end = end0;
    shard1.end = end1;

    await closeShardPools({ pools: [shard0, shard1] });

    expect(end0).toHaveBeenCalledOnce();
    expect(end1).toHaveBeenCalledOnce();
  });
});
