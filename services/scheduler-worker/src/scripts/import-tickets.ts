/**
 * Engångsimport av ett events 5 000 riktiga biljettnummer från CSV
 * (docs/plan.md "Import av biljettnummer (CSV)"). Körs MANUELLT
 * (`node dist/scripts/import-tickets.js <eventId> <csvPath> <priceCents>`),
 * en gång per event innan `sales_open_at` — ALDRIG automatiskt, samma
 * princip som reset-sale.ts och generate-sale-report.ts.
 *
 * CSV-FORMAT (antagande, inte givet av uppgiften — se docs/plan.md
 * "Fas 6 — kända luckor", bekräftat med användaren att den riktiga
 * filens format är okänt tills uppgiften delar den): en kolumn, ett
 * biljettnummer per rad (`[A-Za-z0-9_-]{1,64}`), med eller utan
 * rubrikraden `ticket_number`. Filen säger INGET om sektion/rad/plats
 * — det är meningen (docs/plan.md: arenakartans rad/plats är "ett
 * presentationslager ovanpå" biljettnumret, inte en ersättning för
 * det). Den här importen parar därför ihop CSV-raderna, i filordning,
 * med venuets `venue_seats` i EN FIXERAD deterministisk ordning
 * (sektion → rad (text, LEXIKOGRAFISK sortering) → platsnummer, se
 * `listVenueSeatsOrdered`) — rad 1 i filen blir den först sorterade
 * stolen, och så vidare. Om den riktiga uppgiftens CSV i stället anger
 * sektion/rad/plats per biljettnummer, eller ett annat separatortecken
 * (t.ex. `;`, vanligt i svensk Excel-export), måste `parseTicketNumbers`
 * och ihopparningen bytas ut mot att läsa de kolumnerna direkt.
 *
 * FÖRUTSÄTTNING som INTE skapas av det här skriptet: venuet måste redan
 * ha exakt 5 000 `venue_seats` (arenageometrin). Inget skript i repot
 * seedar en sådan "riktig" venue än (bara 30-sätes demo-venuen i
 * seed-demo-events.ts) — se docs/plan.md "Fas 6 — kända luckor".
 *
 * Idempotent: `ON CONFLICT (event_id, ticket_number) DO NOTHING`
 * (csv-ticket-import-repository.ts) — men en tom diff är inte samma
 * sak som en KORREKT diff. Innan insättning jämförs eventuella
 * BEFINTLIGA rader mot den här körningens plan (samma biljettnummer →
 * samma `venue_seat_id` och pris) — annars hade t.ex. en omkörning med
 * fel pris (kronor skrivet istället för öre) tyst rapporterat "0 nya,
 * 5000 fanns redan" utan att priset någonsin rättades (hittat i review).
 */
import {
  closeShardPools,
  createShardPools,
  getGlobalPool,
  getPoolForEvent,
} from '@tickets/db';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  getEventVenueId,
  getExistingSeats,
  importTicketNumbers,
  listVenueSeatsOrdered,
  type TicketImportPair,
  type VenueSeatRow,
} from '../repositories/csv-ticket-import-repository.js';

const EXPECTED_TICKET_COUNT = 5000;
const HEADER_ROW = 'ticket_number';
const TICKET_NUMBER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRICE_CENTS = 2_147_483_647; // seats.price_cents is a Postgres `integer`

function parseTicketNumbers(csvPath: string): string[] {
  const lines = readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rows = lines[0]?.toLowerCase() === HEADER_ROW ? lines.slice(1) : lines;

  if (rows.length !== EXPECTED_TICKET_COUNT) {
    throw new Error(
      `Expected exactly ${String(EXPECTED_TICKET_COUNT)} ticket numbers, found ${String(rows.length)}`,
    );
  }
  const malformed = rows.find((row) => !TICKET_NUMBER_PATTERN.test(row));
  if (malformed !== undefined) {
    throw new Error(`Not a valid single-column ticket number: "${malformed}"`);
  }
  const unique = new Set(rows);
  if (unique.size !== rows.length) {
    throw new Error(
      `CSV contains ${String(rows.length - unique.size)} duplicate ticket number(s)`,
    );
  }
  return rows;
}

function parsePriceCents(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error('priceCents must be a positive integer (in öre/cents, not kronor)');
  }
  const priceCents = Number(raw);
  if (priceCents <= 0 || priceCents > MAX_PRICE_CENTS) {
    throw new Error(`priceCents must be between 1 and ${String(MAX_PRICE_CENTS)}`);
  }
  return priceCents;
}

function parseEventId(raw: string): string {
  if (!UUID_PATTERN.test(raw)) {
    throw new Error(`Not a valid UUID: "${raw}"`);
  }
  return raw.toLowerCase();
}

function buildImportPairs(
  ticketNumbers: readonly string[],
  venueSeats: readonly VenueSeatRow[],
): TicketImportPair[] {
  return ticketNumbers.map((ticketNumber, index) => {
    const seat = venueSeats[index];
    if (seat === undefined) {
      throw new Error(
        `No venue seat at position ${String(index)} — counts were checked already`,
      );
    }
    return {
      venueSeatId: seat.id,
      sectionId: seat.sectionId,
      row: seat.row,
      number: seat.number,
      ticketNumber,
    };
  });
}

/**
 * Aborts instead of silently re-affirming a mismatched re-run (see the
 * file header's "Idempotent" note) — any existing seat for this event
 * must be exactly one this run would also produce, at the same price.
 */
async function verifyNoConflictingSeats(
  eventPool: Pool,
  eventId: string,
  pairs: readonly TicketImportPair[],
  priceCents: number,
): Promise<void> {
  const existing = await getExistingSeats(eventPool, eventId);
  if (existing.length === 0) {
    return;
  }
  const planned = new Map(pairs.map((pair) => [pair.ticketNumber, pair]));
  for (const seat of existing) {
    const plannedPair = planned.get(seat.ticketNumber);
    if (
      plannedPair === undefined ||
      plannedPair.venueSeatId !== seat.venueSeatId ||
      priceCents !== seat.priceCents
    ) {
      throw new Error(
        `Event already has seats that don't match this CSV/price (e.g. ticket "${seat.ticketNumber}") — ` +
          'refusing to re-run with different data. Reset the event first if that was intended.',
      );
    }
  }
}

async function runImport(
  eventPool: Pool,
  eventId: string,
  pairs: readonly TicketImportPair[],
  priceCents: number,
): Promise<number> {
  const client = await eventPool.connect();
  try {
    return await importTicketNumbers(client, eventId, pairs, priceCents);
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const [eventIdRaw, csvPath, priceCentsRaw] = process.argv.slice(2);
  if (eventIdRaw === undefined || csvPath === undefined || priceCentsRaw === undefined) {
    process.stderr.write(
      'Usage: node dist/scripts/import-tickets.js <eventId> <csvPath> <priceCents>\n',
    );
    process.exitCode = 1;
    return;
  }
  const eventId = parseEventId(eventIdRaw);
  const priceCents = parsePriceCents(priceCentsRaw);
  const ticketNumbers = parseTicketNumbers(csvPath);

  const shardPools = createShardPools();
  try {
    const eventPool = getPoolForEvent(shardPools, eventId);
    const venueId = await getEventVenueId(eventPool, eventId);
    if (venueId === undefined) {
      throw new Error(`Event ${eventId} not found`);
    }
    const venueSeats = await listVenueSeatsOrdered(getGlobalPool(shardPools), venueId);
    if (venueSeats.length !== EXPECTED_TICKET_COUNT) {
      throw new Error(
        `Venue ${venueId} has ${String(venueSeats.length)} seats, expected exactly ${String(EXPECTED_TICKET_COUNT)}`,
      );
    }
    const pairs = buildImportPairs(ticketNumbers, venueSeats);
    await verifyNoConflictingSeats(eventPool, eventId, pairs, priceCents);
    const inserted = await runImport(eventPool, eventId, pairs, priceCents);
    process.stdout.write(
      `Imported ${String(inserted)} new ticket(s) for event ${eventId}, ${String(
        pairs.length - inserted,
      )} already existed.\n`,
    );
  } finally {
    await closeShardPools(shardPools);
  }
}

// Samma symlänk-säkra mönster som src/index.ts och de andra engångsskripten.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
