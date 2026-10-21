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

describe('createShardPools error handling', () => {
  it('attaches an error listener so an idle-client error does not crash the process, and forwards it', () => {
    process.env['DATABASE_URL_SHARD_0'] = 'postgresql://fake-0';
    process.env['DATABASE_URL_SHARD_1'] = 'postgresql://fake-1';
    const onShardError = vi.fn();
    const shardPools = createShardPools({ onShardError });

    const error = new Error('connection terminated unexpectedly');
    // pg.Pool re-emits an idle client's error as an `error` event on
    // the Pool itself; with no listener, that's an uncaught exception.
    // Emitting it directly here is what proves a listener is attached
    // — if it weren't, this `emit` call would throw synchronously.
    expect(() => shardPools.pools[0].emit('error', error)).not.toThrow();
    expect(onShardError).toHaveBeenCalledWith(0, error);

    shardPools.pools[1].emit('error', error);
    expect(onShardError).toHaveBeenCalledWith(1, error);
  });

  it('works with no onShardError callback at all — still must not crash', () => {
    process.env['DATABASE_URL_SHARD_0'] = 'postgresql://fake-0';
    process.env['DATABASE_URL_SHARD_1'] = 'postgresql://fake-1';
    const shardPools = createShardPools();

    expect(() => shardPools.pools[0].emit('error', new Error('boom'))).not.toThrow();
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
