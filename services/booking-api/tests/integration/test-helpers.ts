/**
 * Shared Testcontainers setup for the reservation integration tests
 * (docs/rules.md §8: real Postgres, never mocked). One container plays
 * both shards — the shard-router's own distribution logic already has
 * a dedicated unit test in shared/db; these tests only need a working
 * database to run the reservation transaction against.
 */
import type { ShardPools } from '@tickets/db';
import { createRedisClient, type RedisClient } from '@tickets/redis';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { runner } from 'node-pg-migrate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBAL_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/global');
const SHARDED_MIGRATIONS_DIR = resolve(HERE, '../../../../shared/db/migrations/sharded');
export const SILENT_LOGGER = {
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
  error: (): undefined => undefined,
};

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
  // pg's Pool emits 'error' when an IDLE client is forcibly disconnected
  // (e.g. the container's fast-shutdown on `container.stop()` below, or
  // any transient network blip) — without a listener this is an
  // unhandled Node error that fails the whole test run, even though
  // `stopTestDatabase` already calls `pool.end()` first (same pattern
  // as the real pools in shared/db/src/pools.ts).
  pool.on('error', () => undefined);
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
 * requests. The idempotency claim/complete split (idempotency-repository.ts)
 * is what actually GUARANTEES losers observe `in_flight` — the claim
 * commits on its own before the winner's (slower) seat-locking work
 * even starts, so there's a real window regardless of connection
 * timing. This just removes TCP+auth handshake variance from that
 * window's size, for a faster and more deterministic test — not the
 * thing making the race observable at all.
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

export interface TestRedis {
  readonly container: StartedRedisContainer;
  readonly client: RedisClient;
}

export async function startTestRedis(): Promise<TestRedis> {
  const container = await new RedisContainer('redis:8-alpine').start();
  const client = createRedisClient(container.getConnectionUrl());
  return { container, client };
}

export async function stopTestRedis(redis: TestRedis): Promise<void> {
  await redis.client.quit();
  await redis.container.stop();
}

export async function seedVenueWithSection(
  pool: Pool,
  params: { venueId: string; venueName: string; sectionId: string; sectionName: string },
): Promise<void> {
  await pool.query(`INSERT INTO venues (id, name, city) VALUES ($1, $2, 'Test City')`, [
    params.venueId,
    params.venueName,
  ]);
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, $3, 1)`,
    [params.sectionId, params.venueId, params.sectionName],
  );
}

export async function seedVenueSeat(
  pool: Pool,
  params: {
    venueSeatId: string;
    venueId: string;
    sectionId: string;
    row: string;
    number: number;
    x: number;
    y: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO venue_seats (id, venue_id, section_id, row, number, x, y)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.venueSeatId,
      params.venueId,
      params.sectionId,
      params.row,
      params.number,
      params.x,
      params.y,
    ],
  );
}

export async function seedEventForVenue(
  pool: Pool,
  params: { eventId: string; venueId: string; title?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, $2, $3, 'Test Artist', now() + interval '7 days', now() - interval '1 day', now() + interval '6 days')`,
    [params.eventId, params.venueId, params.title ?? 'Test Event'],
  );
}

export async function seedSeatForSection(
  pool: Pool,
  params: {
    seatId: string;
    eventId: string;
    venueSeatId: string;
    sectionId: string;
    row: string;
    number: number;
    ticketNumber: string;
    status?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, $8)`,
    [
      params.seatId,
      params.eventId,
      params.venueSeatId,
      params.sectionId,
      params.row,
      params.number,
      params.ticketNumber,
      params.status ?? 'available',
    ],
  );
}

export async function seedUser(
  pool: Pool,
  params: { userId: string; auth0Sub: string; email: string },
): Promise<void> {
  await pool.query(`INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, $3, $2)`, [
    params.userId,
    params.auth0Sub,
    params.email,
  ]);
}

export async function seedOrderWithTicket(
  pool: Pool,
  params: {
    orderId: string;
    eventId: string;
    userId: string;
    seatId: string;
    ticketId: string;
    qrToken: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO orders (id, event_id, user_id, total_cents, status) VALUES ($1, $2, $3, 1000, 'paid')`,
    [params.orderId, params.eventId, params.userId],
  );
  await pool.query(
    `INSERT INTO tickets (id, event_id, order_id, seat_id, qr_token, status)
     VALUES ($1, $2, $3, $4, $5, 'valid')`,
    [params.ticketId, params.eventId, params.orderId, params.seatId, params.qrToken],
  );
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
