/**
 * All SQL for `scripts/seed-real-venue.ts` (docs/rules.md §4: "All SQL i
 * repositories/"). `venues`/`venue_sections`/`venue_seats` are global
 * (shard-0, via `getGlobalPool`), `events` is sharded (via
 * `getPoolForEvent`) — same split as csv-ticket-import-repository.ts.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface SeedVenueParams {
  readonly venueId: string;
  readonly sectionId: string;
  readonly venueName: string;
  readonly city: string;
  readonly rows: number;
  readonly seatsPerRow: number;
}

const SEAT_INSERT_BATCH_SIZE = 500;

interface SeatToInsert {
  readonly id: string;
  readonly row: string;
  readonly number: number;
  readonly rowIndex: number;
}

async function insertSeatBatch(
  pool: Pool,
  venueId: string,
  sectionId: string,
  seats: readonly SeatToInsert[],
): Promise<void> {
  const values: unknown[] = [];
  const tuples = seats.map((seat, index) => {
    const base = index * 7;
    values.push(
      seat.id,
      venueId,
      sectionId,
      seat.row,
      seat.number,
      seat.number,
      seat.rowIndex,
    );
    return `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(
      base + 4,
    )}, $${String(base + 5)}, $${String(base + 6)}, $${String(base + 7)})`;
  });
  await pool.query(
    `INSERT INTO venue_seats (id, venue_id, section_id, row, number, x, y)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (id) DO NOTHING`,
    values,
  );
}

/**
 * Creates the venue, one section, and `rows * seatsPerRow` venue_seats
 * (docs/plan.md "Import av biljettnummer (CSV)" assumes exactly 5 000
 * exist before an import can run). All ids are DERIVED from `venueId`
 * (deterministic, not `gen_random_uuid()`), so re-running with the same
 * `venueId` is idempotent — same principle as seed-demo-events.ts.
 *
 * `x`/`y` are set to the seat number / row index — a plain grid, no
 * visual arena map design, since nothing renders this geometry for a
 * load-test venue (both columns are `NOT NULL` on `venue_seats`, so
 * they still need a value either way).
 */
export async function seedVenueWithSeats(pool: Pool, params: SeedVenueParams): Promise<void> {
  await pool.query(
    `INSERT INTO venues (id, name, city) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [params.venueId, params.venueName, params.city],
  );
  await pool.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order)
     VALUES ($1, $2, 'Golv', 1) ON CONFLICT (id) DO NOTHING`,
    [params.sectionId, params.venueId],
  );

  const seats: SeatToInsert[] = [];
  for (let rowIndex = 0; rowIndex < params.rows; rowIndex += 1) {
    for (let seatNumber = 1; seatNumber <= params.seatsPerRow; seatNumber += 1) {
      seats.push({
        id: deriveSeatId(params.venueId, rowIndex, seatNumber),
        row: String(rowIndex + 1),
        number: seatNumber,
        rowIndex,
      });
    }
  }
  for (let start = 0; start < seats.length; start += SEAT_INSERT_BATCH_SIZE) {
    await insertSeatBatch(
      pool,
      params.venueId,
      params.sectionId,
      seats.slice(start, start + SEAT_INSERT_BATCH_SIZE),
    );
  }
}

function deriveSeatId(venueId: string, rowIndex: number, seatNumber: number): string {
  // Stable per (venueId, row, seat) — see seedVenueWithSeats' idempotency note.
  const hash = createHash('sha256')
    .update(`${venueId}:${rowIndex}:${seatNumber}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface SeedEventParams {
  readonly eventId: string;
  readonly venueId: string;
  readonly title: string;
  readonly artist: string;
  readonly category: string;
}

/**
 * Creates the event with `sales_open_at` already in the past — a
 * load-test event needs to be purchasable immediately, unlike a real
 * on-sale date.
 */
export async function seedEvent(pool: Pool, params: SeedEventParams): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, category, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days', now() - interval '1 hour', now() + interval '29 days')
     ON CONFLICT (id) DO NOTHING`,
    [params.eventId, params.venueId, params.title, params.artist, params.category],
  );
}
