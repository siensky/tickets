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
  /** Max anslutningar per shard i den här processen. Standard `DEFAULT_POOL_MAX` (se storleksräkningen nedan). */
  poolMax?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

// Sizing. Each shard is its OWN Postgres server with the default
// max_connections of 100, so the budget is per server: every process
// connected to a shard counts once against THAT shard's 100. Every
// service connects as `postgres` (a superuser), so
// superuser_reserved_connections protects nothing: at 100, even an
// emergency psql is refused. Keep real headroom.
//
// 4 is the default for every service. booking-api raises it with
// DB_POOL_MAX (infra/k8s/base/booking-api/deployment.yaml): the load test
// showed 4 per pod was the bottleneck (all connections busy for the whole
// sale, waits over 5 s became 500s) while Postgres itself was idle.
// Worst case per shard at DB_POOL_MAX=6, mid rolling deploy during a sale
// (a terminating pod still holds its pool; maxSurge doesn't count it):
//   booking-api          (6 HPA max + 1 surge + 1 terminating) × 6 = 48
//   notification-worker  (4 KEDA max + 1 + 1) × 4                  = 24
//   scheduler-worker     1 × 4 (Recreate)                          =  4
//   a local script over port-forward (reset-sale etc.)             =  4
//   migrations Job, backup, postgres-exporter, psql                ~  4
//   total                                                          ~ 84 of 100
export const DEFAULT_POOL_MAX = 4;
const CONNECTION_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 5000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

function createPool(
  connectionString: string,
  shardIndex: 0 | 1,
  options: CreateShardPoolsOptions,
): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  });
  pool.on('error', (error: Error) => {
    options.onShardError?.(shardIndex, error);
  });
  return pool;
}

export function createShardPools(options: CreateShardPoolsOptions = {}): ShardPools {
  const shard0 = createPool(requireEnv('DATABASE_URL_SHARD_0'), 0, options);
  const shard1 = createPool(requireEnv('DATABASE_URL_SHARD_1'), 1, options);
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
