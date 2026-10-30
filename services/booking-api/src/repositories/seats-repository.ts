/**
 * Read-only status queries against the sharded `seats` table
 * (docs/plan.md "Realtid": "Stolarnas status"). The write side (locking,
 * selling, releasing) lives in reservation-repository.ts — this file
 * only ever SELECTs, for the seatmap polling endpoint.
 */
import type { Pool } from 'pg';
import type { SeatStatus, SeatStatusRow, SectionSeatAggregateRow } from '../types/seatmap.js';

interface RawSeatStatusRow {
  id: string;
  venue_seat_id: string;
  status: SeatStatus;
  price_cents: number;
}

/** `event_id` AND `section_id` both present (docs/rules.md §4: shard-nyckel i varje fråga). */
export async function listSeatStatusesForSection(
  pool: Pool,
  eventId: string,
  sectionId: string,
): Promise<SeatStatusRow[]> {
  const { rows } = await pool.query<RawSeatStatusRow>(
    'SELECT id, venue_seat_id, status, price_cents FROM seats WHERE event_id = $1 AND section_id = $2',
    [eventId, sectionId],
  );
  return rows.map((row) => ({
    id: row.id,
    venueSeatId: row.venue_seat_id,
    status: row.status,
    priceCents: row.price_cents,
  }));
}

/**
 * Aggregat per sektion för ett event (docs/plan.md 7.13 E2): lediga/totala
 * stolar och prisintervall. `event_id` i frågan (docs/rules.md §4).
 */
export async function aggregateSeatsBySection(
  pool: Pool,
  eventId: string,
): Promise<SectionSeatAggregateRow[]> {
  const { rows } = await pool.query<{
    section_id: string;
    available_count: string;
    total_count: string;
    min_price_cents: number;
    max_price_cents: number;
  }>(
    `SELECT section_id,
            COUNT(*) FILTER (WHERE status = 'available') AS available_count,
            COUNT(*) AS total_count,
            MIN(price_cents) AS min_price_cents,
            MAX(price_cents) AS max_price_cents
     FROM seats WHERE event_id = $1 GROUP BY section_id`,
    [eventId],
  );
  // COUNT() kommer som bigint, alltså sträng från pg.
  return rows.map((row) => ({
    sectionId: row.section_id,
    availableCount: Number(row.available_count),
    totalCount: Number(row.total_count),
    minPriceCents: row.min_price_cents,
    maxPriceCents: row.max_price_cents,
  }));
}
