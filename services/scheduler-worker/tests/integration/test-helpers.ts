/**
 * Shared Testcontainers setup for the scheduler-worker integration
 * tests (docs/rules.md §8: real Postgres/RabbitMQ, never mocked). Only
 * the sharded migrations run — the outbox table is the only one these
 * tests touch, and it doesn't live on a global table.
 */
import type { ShardPools } from '@tickets/db';
import { createRedisClient, type RedisClient } from '@tickets/redis';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { runner } from 'node-pg-migrate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBAL_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/global');
const SHARDED_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/sharded');
const SILENT_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface TestInfra {
  readonly postgres: StartedPostgreSqlContainer;
  readonly rabbitmq: StartedRabbitMQContainer;
  readonly shardPools: ShardPools;
}

export async function startTestInfra(): Promise<TestInfra> {
  const postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  const rabbitmq = await new RabbitMQContainer('rabbitmq:4-management-alpine').start();

  // Globala migrationer (config, för köns insläppstakt) körs ALLTID
  // mot samma container här — i produktion ligger de bara på shard-0,
  // men testet nedan använder en enda container som båda shardarna.
  await runner({
    databaseUrl: postgres.getConnectionUri(),
    dir: GLOBAL_MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations_global',
    direction: 'up',
    logger: SILENT_LOGGER,
  });
  await runner({
    databaseUrl: postgres.getConnectionUri(),
    dir: SHARDED_MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations_sharded',
    direction: 'up',
    logger: SILENT_LOGGER,
  });

  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  // Se booking-api/tests/integration/test-helpers.ts: samma motivering —
  // pg:s Pool kräver en 'error'-lyssnare, annars blir en containers
  // fast-shutdown-frånkoppling av en vilande klient ett ohanterat fel.
  pool.on('error', () => undefined);
  return { postgres, rabbitmq, shardPools: { pools: [pool, pool] } };
}

export async function seedEvent(
  infra: TestInfra,
  params: { eventId: string; salesOpenAt: Date; salesCloseAt: Date },
): Promise<void> {
  await infra.shardPools.pools[0].query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Test Event', 'Test Artist', now() + interval '7 days', $2, $3)`,
    [params.eventId, params.salesOpenAt, params.salesCloseAt],
  );
}

export async function stopTestInfra(infra: TestInfra): Promise<void> {
  // Not closeShardPools: both entries in infra.shardPools.pools are the
  // SAME Pool instance (one container plays both shards here), and
  // pg's Pool throws if `.end()` is called on it twice.
  await infra.shardPools.pools[0].end();
  await infra.postgres.stop();
  await infra.rabbitmq.stop();
}

export interface TestRedis {
  readonly container: StartedRedisContainer;
  readonly client: RedisClient;
}

export async function startTestRedis(): Promise<TestRedis> {
  const container = await new RedisContainer('redis:8-alpine').start();
  return { container, client: createRedisClient(container.getConnectionUrl()) };
}

export async function stopTestRedis(redis: TestRedis): Promise<void> {
  await redis.client.quit();
  await redis.container.stop();
}

export async function insertOutboxEvent(
  infra: TestInfra,
  params: { eventId: string; type: string; payload: unknown },
): Promise<string> {
  const { rows } = await infra.shardPools.pools[0].query<{ id: string }>(
    'INSERT INTO outbox (event_id, type, payload) VALUES ($1, $2, $3) RETURNING id',
    [params.eventId, params.type, JSON.stringify(params.payload)],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('insertOutboxEvent: INSERT ... RETURNING produced no row');
  }
  return id;
}

export async function getOutboxPublishedAt(
  infra: TestInfra,
  id: string,
): Promise<Date | null> {
  const { rows } = await infra.shardPools.pools[0].query<{ published_at: Date | null }>(
    'SELECT published_at FROM outbox WHERE id = $1',
    [id],
  );
  return rows[0]?.published_at ?? null;
}

/**
 * Polls `check` until it returns true or `timeoutMs` elapses (no
 * `sleep`-and-hope — docs/rules.md §8). Used instead of a fixed wait
 * because container restart and relay-tick timing both vary by CI load.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${options.timeoutMs}ms`);
}
