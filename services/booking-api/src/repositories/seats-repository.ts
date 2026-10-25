/**
 * Read-only status queries against the sharded `seats` table
 * (docs/plan.md "Realtid": "Stolarnas status"). The write side (locking,
 * selling, releasing) lives in reservation-repository.ts — this file
 * only ever SELECTs, for the seatmap polling endpoint.
 */
import type { Pool } from 'pg';
import type { SeatStatus, SeatStatusRow } from '../types/seatmap.js';

interface RawSeatStatusRow {
  id: string;
  venue_seat_id: string;
  status: SeatStatus;
}

/** `event_id` AND `section_id` both present (docs/rules.md §4: shard-nyckel i varje fråga). */
export async function listSeatStatusesForSection(
  pool: Pool,
  eventId: string,
  sectionId: string,
): Promise<SeatStatusRow[]> {
  const { rows } = await pool.query<RawSeatStatusRow>(
    'SELECT id, venue_seat_id, status FROM seats WHERE event_id = $1 AND section_id = $2',
    [eventId, sectionId],
  );
  return rows.map((row) => ({
    id: row.id,
    venueSeatId: row.venue_seat_id,
    status: row.status,
  }));
}
