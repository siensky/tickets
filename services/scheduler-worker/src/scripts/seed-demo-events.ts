/**
 * Fyller startsidan med utvalda evenemang över alla kategorier
 * (docs/plan.md Fas 6: "utvalda konserter/evenemang + utfyllnadsinnehåll").
 * Det enda RIKTIGA eventet (CSV-importerat, 5 000 biljetter) förblir
 * orört — detta skript lägger bara till DEMO-event, med en liten delad
 * arenageometri (30 platser) så "köp biljetter" faktiskt leder in i ett
 * fungerande, om än litet, bokningsflöde (docs/plan.md: "leder in i det
 * redan byggda bokningsflödet"), inte bara ett utställningsfönster.
 *
 * Idempotent: fasta UUID:er, `ON CONFLICT DO NOTHING` — körs en gång,
 * ofarligt att köra om (samma princip som CSV-importen,
 * scripts/import-tickets.ts, docs/plan.md "Databas").
 *
 * Eventen (sharded) och deras `seats` skrivs bara till DEN shard
 * eventet faktiskt hashar till (`getPoolForEvent`) — till skillnad från
 * tests/e2e/seed.ts, som ofarligt kan duplicera sin fixture på båda
 * shards eftersom den bara läser ETT känt event-id. Här LISTAR
 * `listAllEvents` (events-service.ts) events via en riktig scatter-
 * gather-sammanslagning av båda shards — en dubblett hade synts två
 * gånger på startsidan.
 */
import { closeShardPools, createShardPools, getPoolForEvent } from '@tickets/db';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const DEMO_VENUE_ID = '00000000-0000-4000-8000-000000000101';
const DEMO_SECTION_ID = '00000000-0000-4000-8000-000000000102';
const SEATS_PER_EVENT = 30; // 6 rader (A-F) x 5 platser
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F'];

interface DemoEvent {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly category: 'music' | 'sports' | 'theatre' | 'festival';
}

const DEMO_EVENTS: readonly DemoEvent[] = [
  {
    id: '00000000-0000-4000-8000-000000000201',
    title: 'Midnight Echoes Live',
    artist: 'Midnight Echoes',
    category: 'music',
  },
  {
    id: '00000000-0000-4000-8000-000000000202',
    title: 'Derby-finalen',
    artist: 'Hemmalaget',
    category: 'sports',
  },
  {
    id: '00000000-0000-4000-8000-000000000203',
    title: 'Mästerskapsmatchen',
    artist: 'Bortalaget',
    category: 'sports',
  },
  {
    id: '00000000-0000-4000-8000-000000000204',
    title: 'Ett Dockhem',
    artist: 'Stadsteatern',
    category: 'theatre',
  },
  {
    id: '00000000-0000-4000-8000-000000000205',
    title: 'Sommarnattsfestivalen',
    artist: 'Flera artister',
    category: 'festival',
  },
];

function venueSeatId(rowIndex: number, seatNumber: number): string {
  // Fast, deterministisk UUID per (rad, plats) — samma geometri delas av
  // alla demo-event, bara `seats`-raderna (per event) skiljer sig.
  const index = rowIndex * 5 + seatNumber;
  return `00000000-0000-4000-8000-0000000001${String(10 + index).padStart(2, '0')}`;
}

async function seedGlobalVenue(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO venues (id, name, city) VALUES ($1, 'Demo Arena', 'Stockholm')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_VENUE_ID],
  );
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order)
     VALUES ($1, $2, 'Golv', 1) ON CONFLICT (id) DO NOTHING`,
    [DEMO_SECTION_ID, DEMO_VENUE_ID],
  );
  for (const [rowIndex, row] of ROWS.entries()) {
    for (let seatNumber = 1; seatNumber <= 5; seatNumber += 1) {
      await pool.query(
        `INSERT INTO venue_seats (id, venue_id, section_id, row, number, x, y)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [
          venueSeatId(rowIndex, seatNumber),
          DEMO_VENUE_ID,
          DEMO_SECTION_ID,
          row,
          seatNumber,
          seatNumber,
          rowIndex + 1,
        ],
      );
    }
  }
}

async function seedShardedEvent(pool: Pool, event: DemoEvent): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, category, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days', now() - interval '1 day', now() + interval '29 days')
     ON CONFLICT (id) DO NOTHING`,
    [event.id, DEMO_VENUE_ID, event.title, event.artist, event.category],
  );
  let seatIndex = 0;
  for (const [rowIndex, row] of ROWS.entries()) {
    for (let seatNumber = 1; seatNumber <= 5; seatNumber += 1) {
      seatIndex += 1;
      await pool.query(
        `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 29900) ON CONFLICT (id) DO NOTHING`,
        [
          deterministicSeatId(event.id, seatIndex),
          event.id,
          venueSeatId(rowIndex, seatNumber),
          DEMO_SECTION_ID,
          row,
          seatNumber,
          `DEMO-${event.id.slice(-4)}-${String(seatIndex).padStart(2, '0')}`,
        ],
      );
    }
  }
}

function deterministicSeatId(eventId: string, seatIndex: number): string {
  // `seats.id` måste vara unikt GLOBALT (PK), inte bara per event —
  // kombinerar eventets egen suffix med platsindex.
  return `00000000-0000-4000-8000-0000${eventId.slice(-4)}${String(seatIndex).padStart(4, '0')}`;
}

async function main(): Promise<void> {
  if (SEATS_PER_EVENT !== ROWS.length * 5) {
    throw new Error('SEATS_PER_EVENT must match ROWS.length * 5');
  }
  const shardPools = createShardPools();
  try {
    await seedGlobalVenue(shardPools.pools[0]);
    for (const event of DEMO_EVENTS) {
      // TILL SKILLNAD FRÅN tests/e2e/seed.ts: skriv bara till den shard
      // eventet faktiskt hashar till. `listAllEvents` (events-service.ts)
      // gör en RIKTIG scatter-gather-sammanslagning av båda shards —
      // att duplicera raden på båda hade visat varje demo-event TVÅ
      // gånger på startsidan (upptäckt i Fas 6-reviewn). e2e-fixturen
      // kommer undan med dubbletten bara eftersom den aldrig listar,
      // bara läser ETT event via sitt kända id.
      await seedShardedEvent(getPoolForEvent(shardPools, event.id), event);
    }
    process.stdout.write(`Seeded ${String(DEMO_EVENTS.length)} demo events.\n`);
  } finally {
    await closeShardPools(shardPools);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
