/**
 * Engångsskapande av ett RIKTIGT events venue + `venue_seats` + själva
 * event-raden, inför `import-tickets.ts` (docs/plan.md "Import av
 * biljettnummer (CSV)" förutsätter att venuet redan har exakt 5 000
 * `venue_seats` — inget annat skript gjorde det, se docs/plan.md
 * "Fas 6 — kända luckor"). Körs MANUELLT
 * (`node dist/scripts/seed-real-venue.js <eventId> <title> <artist>
 * <category> <rows> <seatsPerRow> <venueName> <city>`), aldrig
 * automatiskt — samma princip som de andra engångsskripten här.
 *
 * `sales_open_at` sätts en timme bakåt i tiden (inte en riktig
 * framtida on-sale-tid) — ett lasttest måste kunna köpa biljetter
 * OMEDELBART.
 *
 * Idempotent: alla id:n (venue, sektion, varje säte) är DERIVERADE från
 * `venueId` (som i sin tur är härlett ur `eventId`), inte slumpade —
 * `ON CONFLICT DO NOTHING` överallt (real-venue-seed-repository.ts), så
 * en omkörning med samma `eventId` är ofarlig.
 */
import {
  closeShardPools,
  createShardPools,
  getGlobalPool,
  getPoolForEvent,
} from '@tickets/db';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedEvent, seedVenueWithSeats } from '../repositories/real-venue-seed-repository.js';

const EXPECTED_SEAT_COUNT = 5000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CATEGORIES = ['music', 'sports', 'theatre', 'festival'];

function deriveUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

interface Args {
  readonly eventId: string;
  readonly title: string;
  readonly artist: string;
  readonly category: string;
  readonly rows: number;
  readonly seatsPerRow: number;
  readonly venueName: string;
  readonly city: string;
}

function parseArgs(argv: readonly string[]): Args {
  const [eventId, title, artist, category, rowsRaw, seatsPerRowRaw, venueName, city] = argv;
  if (
    eventId === undefined ||
    title === undefined ||
    artist === undefined ||
    category === undefined ||
    rowsRaw === undefined ||
    seatsPerRowRaw === undefined ||
    venueName === undefined ||
    city === undefined
  ) {
    throw new Error(
      'Usage: node dist/scripts/seed-real-venue.js <eventId> <title> <artist> <category> <rows> <seatsPerRow> <venueName> <city>',
    );
  }
  if (!UUID_PATTERN.test(eventId)) {
    throw new Error(`Not a valid UUID: "${eventId}"`);
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }
  const rows = Number(rowsRaw);
  const seatsPerRow = Number(seatsPerRowRaw);
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(seatsPerRow) ||
    rows * seatsPerRow !== EXPECTED_SEAT_COUNT
  ) {
    throw new Error(
      `rows * seatsPerRow must equal exactly ${String(EXPECTED_SEAT_COUNT)} (got ${rowsRaw} * ${seatsPerRowRaw})`,
    );
  }
  return {
    eventId: eventId.toLowerCase(),
    title,
    artist,
    category,
    rows,
    seatsPerRow,
    venueName,
    city,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const venueId = deriveUuid(`venue:${args.eventId}`);
  const sectionId = deriveUuid(`section:${args.eventId}`);

  const shardPools = createShardPools();
  try {
    await seedVenueWithSeats(getGlobalPool(shardPools), {
      venueId,
      sectionId,
      venueName: args.venueName,
      city: args.city,
      rows: args.rows,
      seatsPerRow: args.seatsPerRow,
    });
    await seedEvent(getPoolForEvent(shardPools, args.eventId), {
      eventId: args.eventId,
      venueId,
      title: args.title,
      artist: args.artist,
      category: args.category,
    });
    process.stdout.write(
      `Seeded venue ${venueId} (${String(args.rows * args.seatsPerRow)} seats) and event ${args.eventId}.\n`,
    );
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
