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

export interface CreateShardPoolsOptions {
  /**
   * Called when an IDLE client in one of the pools errors out — e.g.
   * the shard it's connected to goes down. Without a listener here,
   * `pg.Pool` re-emits that as an `error` event on the `Pool` itself,
   * and an EventEmitter `error` with no listener is an uncaught
   * exception that crashes the whole process (docs/plan.md's own
   * demo script kills shard-1 live expecting shard-0 to keep serving
   * traffic — without this, killing shard-1 would kill the pod).
   */
  onShardError?: (shardIndex: 0 | 1, error: Error) => void;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

// Sizing (docs/plan.md "Infrastruktur": "Testcontainers: höj
// max_connections" is about the TEST scenario — this is the separate
// production trap it flags: booking-api's HPA scales to 10 replicas,
// each with its OWN pool per shard. At the default pg.Pool max of 10,
// that's 10 × 10 × 2 shards = 200 possible connections against a
// Postgres whose default max_connections is 100. `max: 4` keeps 10
// replicas × 4 × 2 shards = 80, leaving headroom for scheduler-worker,
// the migrations Job, and postgres-exporter. Revisit with real numbers
// once Fas 6 measures the HPA curve under load.
const POOL_MAX = 4;
const CONNECTION_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 5000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

function createPool(
  connectionString: string,
  shardIndex: 0 | 1,
  onShardError?: CreateShardPoolsOptions['onShardError'],
): Pool {
  const pool = new Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
  pool.on('error', (error: Error) => {
    onShardError?.(shardIndex, error);
  });
  return pool;
}

export function createShardPools(options: CreateShardPoolsOptions = {}): ShardPools {
  const shard0 = createPool(requireEnv('DATABASE_URL_SHARD_0'), 0, options.onShardError);
  const shard1 = createPool(requireEnv('DATABASE_URL_SHARD_1'), 1, options.onShardError);
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
