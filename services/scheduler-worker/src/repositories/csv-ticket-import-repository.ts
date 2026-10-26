/**
 * All SQL for `scripts/import-tickets.ts` (docs/rules.md §4: "All SQL i
 * repositories/"). `events`/`seats` are sharded (picked via
 * `getPoolForEvent`), `venue_seats`/`venue_sections` are global
 * (shard-0, via `getGlobalPool`) — this file talks to both pools, the
 * script never runs raw SQL itself.
 */
import type { Pool, PoolClient } from 'pg';

export interface VenueSeatRow {
  readonly id: string;
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
}

/** `undefined` when the event doesn't exist — the script turns that into a clear error. */
export async function getEventVenueId(
  pool: Pool,
  eventId: string,
): Promise<string | undefined> {
  const result = await pool.query<{ venue_id: string }>(
    'SELECT venue_id FROM events WHERE id = $1',
    [eventId],
  );
  return result.rows[0]?.venue_id;
}

/**
 * Every seat the venue's arena map defines, in a fixed deterministic
 * order (section display order, then row, then seat number, with
 * `sec.id`/`vs.id` as tie-breakers since `display_order` alone isn't
 * unique per docs/plan.md's own schema — without those, two rows with
 * the same `display_order` could come back in a different order on
 * every run, found in review) — paired positionally with the CSV's
 * ticket numbers by the caller. The CSV itself carries no row/seat
 * information (docs/plan.md "Import av biljettnummer (CSV)": row/seat
 * position is "ett presentationslager ovanpå" the ticket number, not
 * part of it), so this ordering is the one place that decides which
 * physical seat gets which ticket number. `vs.row` sorts as TEXT, so
 * this is only "row 1 in the file = the geometrically first seat" for
 * single-letter rows — documented as such in import-tickets.ts.
 */
export async function listVenueSeatsOrdered(
  pool: Pool,
  venueId: string,
): Promise<VenueSeatRow[]> {
  const result = await pool.query<{
    id: string;
    section_id: string;
    row: string;
    number: number;
  }>(
    `SELECT vs.id, vs.section_id, vs.row, vs.number
     FROM venue_seats vs
     JOIN venue_sections sec ON sec.id = vs.section_id
     WHERE vs.venue_id = $1
     ORDER BY sec.display_order, sec.id, vs.row, vs.number, vs.id`,
    [venueId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    sectionId: row.section_id,
    row: row.row,
    number: row.number,
  }));
}

export interface ExistingSeatRow {
  readonly ticketNumber: string;
  readonly venueSeatId: string;
  readonly priceCents: number;
}

/**
 * Seats already imported for this event, if any — lets the script
 * verify a re-run's CSV/price still agree with what's already there
 * instead of trusting `ON CONFLICT DO NOTHING`'s silence (found in
 * review: a re-run with a different price, or against an event whose
 * `venue_id` changed, previously reported "0 new, N already existed"
 * without checking either).
 */
export async function getExistingSeats(
  pool: Pool,
  eventId: string,
): Promise<ExistingSeatRow[]> {
  const result = await pool.query<{
    ticket_number: string;
    venue_seat_id: string;
    price_cents: number;
  }>('SELECT ticket_number, venue_seat_id, price_cents FROM seats WHERE event_id = $1', [
    eventId,
  ]);
  return result.rows.map((row) => ({
    ticketNumber: row.ticket_number,
    venueSeatId: row.venue_seat_id,
    priceCents: row.price_cents,
  }));
}

export interface TicketImportPair {
  readonly venueSeatId: string;
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
  readonly ticketNumber: string;
}

const INSERT_BATCH_SIZE = 500;

async function insertBatch(
  client: PoolClient,
  eventId: string,
  batch: readonly TicketImportPair[],
  priceCents: number,
): Promise<number> {
  const values: unknown[] = [];
  const tuples = batch.map((pair, index) => {
    const base = index * 7;
    values.push(
      eventId,
      pair.venueSeatId,
      pair.sectionId,
      pair.row,
      pair.number,
      pair.ticketNumber,
      priceCents,
    );
    return `($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)}, $${String(
      base + 4,
    )}, $${String(base + 5)}, $${String(base + 6)}, $${String(base + 7)})`;
  });
  const result = await client.query(
    `INSERT INTO seats (event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (event_id, ticket_number) DO NOTHING`,
    values,
  );
  return result.rowCount ?? 0;
}

/**
 * `INSERT ... ON CONFLICT (event_id, ticket_number) DO NOTHING`
 * (docs/plan.md) — idempotent, safe to re-run with the same CSV.
 * Batches the 5 000 rows into fixed-size multi-row `INSERT`s rather
 * than one query per row, all inside one transaction on the caller's
 * connection (same reasoning as sale-reset-repository.ts: `BEGIN`/
 * `COMMIT` must run on the SAME physical connection, so this function
 * owns the whole transaction rather than trusting `Pool.query()`).
 */
export async function importTicketNumbers(
  client: PoolClient,
  eventId: string,
  pairs: readonly TicketImportPair[],
  priceCents: number,
): Promise<number> {
  await client.query('BEGIN');
  try {
    let inserted = 0;
    for (let start = 0; start < pairs.length; start += INSERT_BATCH_SIZE) {
      inserted += await insertBatch(
        client,
        eventId,
        pairs.slice(start, start + INSERT_BATCH_SIZE),
        priceCents,
      );
    }
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
