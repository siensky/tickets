/**
 * Shared Testcontainers setup for the reservation integration tests
 * (docs/rules.md §8: real Postgres, never mocked). One container plays
 * both shards — the shard-router's own distribution logic already has
 * a dedicated unit test in shared/db; these tests only need a working
 * database to run the reservation transaction against.
 */
import type { ShardPools } from '@tickets/db';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBAL_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/global');
const SHARDED_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/sharded');
const SILENT_LOGGER = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  readonly shardPools: ShardPools;
}

async function runMigrations(
  databaseUrl: string,
  dir: string,
  migrationsTable: string,
): Promise<void> {
  await runner({
    databaseUrl,
    dir,
    migrationsTable,
    direction: 'up',
    logger: SILENT_LOGGER,
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const connectionUri = container.getConnectionUri();

  await runMigrations(connectionUri, GLOBAL_MIGRATIONS_DIR, 'pgmigrations_global');
  await runMigrations(connectionUri, SHARDED_MIGRATIONS_DIR, 'pgmigrations_sharded');

  const pool = new Pool({ connectionString: connectionUri, max: 20 });
  return { container, shardPools: { pools: [pool, pool] } };
}

export async function stopTestDatabase(db: TestDatabase): Promise<void> {
  // Not closeShardPools: both entries in db.shardPools.pools are the
  // SAME Pool instance (one container plays both shards here), and
  // pg's Pool throws if `.end()` is called on it twice.
  await db.shardPools.pools[0].end();
  await db.container.stop();
}

/**
 * Opens `count` connections and immediately releases them, so the pool
 * has that many already established before a test fires concurrent
 * requests. Without this, the first N requests pay for TCP+auth
 * handshakes that can take longer than the tiny reservation transaction
 * itself — which would let a "loser" see the winner's row as already
 * `completed` instead of `in_flight`, the opposite of what the
 * idempotency crown-jewel test needs to exercise.
 */
export async function warmPool(pool: Pool, count: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  for (const client of clients) {
    client.release();
  }
}

export async function seedEventWithSeats(
  pool: Pool,
  params: { eventId: string; seatIds: readonly string[] },
): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Test Event', 'Test Artist',
             now() + interval '7 days', now() - interval '1 day', now() + interval '6 days')`,
    [params.eventId],
  );
  for (const [index, seatId] of params.seatIds.entries()) {
    await pool.query(
      `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'A', $3, $4, 1000)`,
      [seatId, params.eventId, index + 1, `TICKET-${params.eventId}-${index}`],
    );
  }
}

export async function getSeatStatuses(
  pool: Pool,
  seatIds: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM seats WHERE id = ANY($1)',
    [seatIds],
  );
  return new Map(rows.map((row) => [row.id, row.status]));
}
