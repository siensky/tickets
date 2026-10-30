/**
 * Läsande SQL för att kontrollera databasens tillstånd, plus fixturen som
 * skapar ett eget event per test (docs/plan.md 7.14). Samma teknik som
 * tests/e2e/seed.ts: eventet och dess stolar läggs på BÅDA shardarna, så
 * testet inte behöver känna till shard-routingen. Köp, ordrar och biljetter
 * hamnar bara på den riktiga shardens rader. Bara fixturen skriver.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DATABASE_URL_SHARD_0, DATABASE_URL_SHARD_1 } from './env.js';

export const SYSTEM_TEST_TITLE_PREFIX = 'SYSTEMTEST';

const pools = [
  new pg.Pool({ connectionString: DATABASE_URL_SHARD_0, max: 4 }),
  new pg.Pool({ connectionString: DATABASE_URL_SHARD_1, max: 4 }),
] as const;
const globalPool = pools[0];

export async function closePools(): Promise<void> {
  await Promise.all(pools.map((pool) => pool.end()));
}

export interface TestEvent {
  readonly eventId: string;
  readonly venueId: string;
  readonly sectionId: string;
  readonly seatIds: readonly string[];
}

export async function createEvent(params: {
  seatCount: number;
  priceCents?: number;
}): Promise<TestEvent> {
  const venueId = randomUUID();
  const sectionId = randomUUID();
  const eventId = randomUUID();
  const seatIds = Array.from({ length: params.seatCount }, () => randomUUID());
  await globalPool.query(
    `INSERT INTO venues (id, name, city) VALUES ($1, 'Systemtestarenan', 'Testby')`,
    [venueId],
  );
  await globalPool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, 'Parkett', 1)`,
    [sectionId, venueId],
  );
  for (const pool of pools) {
    await pool.query(
      `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
       VALUES ($1, $2, $3, 'Systemtest', now() + interval '7 days',
               now() - interval '1 day', now() + interval '6 days')`,
      [eventId, venueId, `${SYSTEM_TEST_TITLE_PREFIX} ${eventId}`],
    );
    for (const [index, seatId] of seatIds.entries()) {
      await pool.query(
        `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
         VALUES ($1, $2, gen_random_uuid(), $3, 'A', $4, $5, $6)`,
        [
          seatId,
          eventId,
          sectionId,
          index + 1,
          `${eventId}-${String(index + 1)}`,
          params.priceCents ?? 45_000,
        ],
      );
    }
  }
  return { eventId, venueId, sectionId, seatIds };
}

/** Kör en läsfråga på båda shardarna och slår ihop raderna. */
export async function queryBothShards<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const results = await Promise.all(pools.map((pool) => pool.query<T>(sql, [...params])));
  return results.flatMap((result) => result.rows);
}

export async function setConfig(key: string, value: string): Promise<void> {
  await globalPool.query(
    `INSERT INTO config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function getConfig(key: string): Promise<string | undefined> {
  const { rows } = await globalPool.query<{ value: string }>(
    'SELECT value FROM config WHERE key = $1',
    [key],
  );
  return rows[0]?.value;
}

export async function deleteConfig(key: string): Promise<void> {
  await globalPool.query('DELETE FROM config WHERE key = $1', [key]);
}
