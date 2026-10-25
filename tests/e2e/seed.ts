/**
 * Seeds one venue/section/event/seats fixture for the e2e suite
 * (docs/plan.md "Domän och användarflöde"). Runs once against the
 * long-lived Postgres the CI job starts via docker-compose.yml — not
 * Testcontainers, which booking-api's own integration tests use instead
 * for a fresh per-file database (see
 * services/booking-api/tests/integration/test-helpers.ts).
 *
 * Events/seats are seeded on BOTH shards: this fixture's event id isn't
 * guaranteed to hash to shard 0 (shared/db/src/shard-router.ts), and
 * duplicating a few harmless rows onto the shard that ends up unused is
 * simpler and more robust than computing the hash here to pick one.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export const E2E_VENUE_ID = '00000000-0000-0000-0000-000000000001';
export const E2E_SECTION_ID = '00000000-0000-0000-0000-000000000002';
export const E2E_EVENT_ID = '00000000-0000-0000-0000-000000000003';
export const E2E_VENUE_SEAT_IDS = [
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000012',
] as const;
const E2E_SEAT_IDS = [
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000022',
] as const;

async function resetGlobalFixture(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM venue_seats WHERE section_id = $1', [E2E_SECTION_ID]);
  await pool.query('DELETE FROM venue_sections WHERE id = $1', [E2E_SECTION_ID]);
  await pool.query('DELETE FROM venues WHERE id = $1', [E2E_VENUE_ID]);
}

async function insertGlobalFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO venues (id, name, city) VALUES ($1, 'E2E Arena', 'Testville')`,
    [E2E_VENUE_ID],
  );
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, 'A', 1)`,
    [E2E_SECTION_ID, E2E_VENUE_ID],
  );
  for (const [index, venueSeatId] of E2E_VENUE_SEAT_IDS.entries()) {
    await pool.query(
      `INSERT INTO venue_seats (id, venue_id, section_id, row, number, x, y)
       VALUES ($1, $2, $3, 'A', $4, $5, 1)`,
      [venueSeatId, E2E_VENUE_ID, E2E_SECTION_ID, index + 1, index + 1],
    );
  }
}

async function resetShardedFixture(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM seats WHERE event_id = $1', [E2E_EVENT_ID]);
  await pool.query('DELETE FROM events WHERE id = $1', [E2E_EVENT_ID]);
}

async function insertShardedFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, $2, 'E2E Concert', 'E2E Artist', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days')`,
    [E2E_EVENT_ID, E2E_VENUE_ID],
  );
  for (const [index, seatId] of E2E_SEAT_IDS.entries()) {
    await pool.query(
      `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
       VALUES ($1, $2, $3, $4, 'A', $5, $6, 1000)`,
      [
        seatId,
        E2E_EVENT_ID,
        E2E_VENUE_SEAT_IDS[index],
        E2E_SECTION_ID,
        index + 1,
        `E2E-TICKET-${index}`,
      ],
    );
  }
}

async function seed(): Promise<void> {
  const shard0 = new Pool({
    connectionString:
      process.env['DATABASE_URL_SHARD_0'] ??
      'postgresql://postgres:postgres@localhost:5432/tickets',
  });
  const shard1 = new Pool({
    connectionString:
      process.env['DATABASE_URL_SHARD_1'] ??
      'postgresql://postgres:postgres@localhost:5452/tickets',
  });

  await resetShardedFixture(shard0);
  await resetShardedFixture(shard1);
  await resetGlobalFixture(shard0);

  await insertGlobalFixture(shard0);
  await insertShardedFixture(shard0);
  await insertShardedFixture(shard1);

  await Promise.all([shard0.end(), shard1.end()]);
  process.stdout.write('Seeded e2e fixture data.\n');
}

// Bara om filen körs direkt som skript (`tsx seed.ts`) — INTE när den
// importeras för sina exporterade id-konstanter (specs/*.spec.ts gör
// det för E2E_EVENT_ID). Utan den här vakten körde seed() om sig själv
// en gång per import, vilket i praktiken betydde en gång per Playwright-
// testfilsladdning OCH en gång per CI-retry — en konkurrerande
// DELETE+INSERT av exakt den rad testet precis navigerade till, mitt i
// körningen. Samma symlänk-fallgrop och samma lösning som
// services/booking-api/src/index.ts:s egen `isMain`-kommentar beskriver.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  seed().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
