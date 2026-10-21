/**
 * Connection pools for both Postgres shards (docs/plan.md "Databas":
 * "Två Postgres-poddar i samma kluster"). Shard 0 also holds the global
 * tables (users, venues, config) — `getGlobalPool` always returns it,
 * regardless of any event_id.
 *
 * Deliberately fixed at exactly two shards, matching the plan — not a
 * generic N-shard abstraction, since there's no third shard to design
 * for.
 */
import { Pool } from 'pg';
import { hashEventIdToShardIndex } from './shard-router.js';

export interface ShardPools {
  readonly pools: readonly [Pool, Pool];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function createShardPools(): ShardPools {
  const shard0 = new Pool({ connectionString: requireEnv('DATABASE_URL_SHARD_0') });
  const shard1 = new Pool({ connectionString: requireEnv('DATABASE_URL_SHARD_1') });
  return { pools: [shard0, shard1] };
}

/** Global tables (users, venues, config — docs/plan.md "Databas") live only on shard-0. */
export function getGlobalPool(shardPools: ShardPools): Pool {
  return shardPools.pools[0];
}

export function getPoolForEvent(shardPools: ShardPools, eventId: string): Pool {
  const shardIndex = hashEventIdToShardIndex(eventId, shardPools.pools.length);
  // shardIndex is always within bounds: hashEventIdToShardIndex mods by
  // shardPools.pools.length, which TypeScript can't see through the
  // array-access-returns-undefined rule (noUncheckedIndexedAccess).
  return shardPools.pools[shardIndex] as Pool;
}

export async function closeShardPools(shardPools: ShardPools): Promise<void> {
  await Promise.all(shardPools.pools.map((pool) => pool.end()));
}
