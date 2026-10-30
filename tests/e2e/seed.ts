/**
 * Seeds one venue/section and six events (one per spec) with seats as the fixture for the e2e suite
 * (docs/plan.md "Domän och användarflöde"). Runs once against the
 * long-lived Postgres the CI job starts via docker-compose.yml — not
 * Testcontainers, which booking-api's own integration tests use instead
 * for a fresh per-file database (see
 * services/booking-api/tests/integration/test-helpers.ts).
 *
 * Varje event seedas på den shard dess id hashar till (shared/db/src/shard-router.ts).
 * Äldre körningar la dem på båda shardarna, så reset rensar båda.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashEventIdToShardIndex } from '@tickets/db';
import { Pool } from 'pg';

// Fasta men GILTIGA v4-formade UUID:er (version-nibble "4", variant-
// nibble "8") — Zod's .uuid() (shared/schemas) kräver RFC 4122-formen
// och godtar bara nil-UUID:n som specialfall, inte en godtycklig
// all-nollor-plus-suffix-sträng. Hittat live i CI: GET /events/:id
// m.fl. avvisade de gamla "00000000-...-00000000000X"-id:na med 400,
// innan testet ens hann navigera dit.
export const E2E_VENUE_ID = '00000000-0000-4000-8000-000000000001';
export const E2E_SECTION_ID = '00000000-0000-4000-8000-000000000002';
const SEATS_PER_EVENT = 3;
const PRICE_CENTS = 1000;

/**
 * Ett event per spec (docs/plan.md 7.15): en reservation håller stolarna i fem minuter och ett
 * köp gör dem sålda, så specarna kan inte dela event utan att ta stolar av varandra. `booking`
 * är det klassiska fixturen som flödestestet använder.
 */
const E2E_EVENT_DEFINITIONS = [
  { key: 'booking', number: 3, title: 'E2E Concert' },
  { key: 'keyboard', number: 4, title: 'E2E Keyboard Show' },
  { key: 'mobile', number: 5, title: 'E2E Mobile Show' },
  { key: 'expiry', number: 6, title: 'E2E Expiry Show' },
  { key: 'taken', number: 7, title: 'E2E Seat Taken Show' },
  { key: 'a11y', number: 8, title: 'E2E A11y Show' },
] as const;

export type E2eEventKey = (typeof E2E_EVENT_DEFINITIONS)[number]['key'];

const pad2 = (value: number): string => value.toString().padStart(2, '0');
const uuid = (suffix: string): string => `00000000-0000-4000-8000-${suffix}`;

export const E2E_VENUE_SEAT_IDS = Array.from({ length: SEATS_PER_EVENT }, (_, index) =>
  uuid(`0000000010${pad2(index + 1)}`),
);

function seatIdsFor(eventNumber: number): string[] {
  return Array.from({ length: SEATS_PER_EVENT }, (_, index) =>
    uuid(`0000001${pad2(eventNumber)}${pad2(index + 1)}0`),
  );
}

export const E2E_EVENTS = Object.fromEntries(
  E2E_EVENT_DEFINITIONS.map(({ key, number, title }) => [
    key,
    { id: uuid(`0000000000${pad2(number)}`), title, seatIds: seatIdsFor(number) },
  ]),
) as Record<E2eEventKey, { id: string; title: string; seatIds: string[] }>;

export const E2E_EVENT_ID = E2E_EVENTS.booking.id;

async function resetGlobalFixture(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM venue_seats WHERE section_id = $1', [E2E_SECTION_ID]);
  await pool.query('DELETE FROM venue_sections WHERE id = $1', [E2E_SECTION_ID]);
  await pool.query('DELETE FROM venues WHERE id = $1', [E2E_VENUE_ID]);
}

async function insertGlobalFixture(pool: Pool): Promise<void> {
  // Arenan har layout (scen + sektion i koordinatsystemet 0–1000 × 0–700, docs/plan.md E2/E3),
  // så att översiktskartan testas. Kortrutnätet (utan layout) täcks av enhetstest.
  await pool.query(
    `INSERT INTO venues (id, name, city, stage_x, stage_y, stage_width, stage_height)
     VALUES ($1, 'E2E Arena', 'Testville', 300, 40, 400, 80)`,
    [E2E_VENUE_ID],
  );
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order, layout_x, layout_y,
                                 layout_width, layout_height, layout_rotation)
     VALUES ($1, $2, 'A', 1, 250, 200, 500, 300, 0)`,
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
  for (const event of Object.values(E2E_EVENTS)) {
    await pool.query('DELETE FROM seats WHERE event_id = $1', [event.id]);
    await pool.query('DELETE FROM events WHERE id = $1', [event.id]);
  }
}

/**
 * Varje event läggs bara på SIN shard (samma hash som routinglagret): `GET /events` slår ihop
 * båda shardarna, så ett event på båda skulle visas två gånger i listan.
 */
async function insertShardedFixture(shards: readonly Pool[]): Promise<void> {
  for (const event of Object.values(E2E_EVENTS)) {
    const pool = shards[hashEventIdToShardIndex(event.id, shards.length)];
    if (pool === undefined) {
      throw new Error(`Ingen shard för event ${event.id}`);
    }
    await pool.query(
      `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
       VALUES ($1, $2, $3, 'E2E Artist', now() + interval '7 days',
               now() - interval '1 day', now() + interval '6 days')`,
      [event.id, E2E_VENUE_ID, event.title],
    );
    for (const [index, seatId] of event.seatIds.entries()) {
      await pool.query(
        `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
         VALUES ($1, $2, $3, $4, 'A', $5, $6, $7)`,
        [
          seatId,
          event.id,
          E2E_VENUE_SEAT_IDS[index],
          E2E_SECTION_ID,
          index + 1,
          `E2E-${event.id.slice(-2)}-${index}`,
          PRICE_CENTS,
        ],
      );
    }
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
  await insertShardedFixture([shard0, shard1]);

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
