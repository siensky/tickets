/**
 * Database-row ↔ API-object conversion for the seat-status cache
 * (docs/rules.md §1). `parseCachedSeatStatuses` narrows the cached JSON
 * string back to `SeatStatusEntry[]` with `as` — allowed here per
 * docs/rules.md §2 because the shape was written by `toSeatStatusEntries`
 * itself a couple of seconds earlier (same contract as
 * reservation-mapper.ts's `parseReplayedReservationResult`).
 */
import type { SeatStatusEntry, SeatStatusRow } from '../types/seatmap.js';

export function toSeatStatusEntries(rows: readonly SeatStatusRow[]): SeatStatusEntry[] {
  return rows.map((row) => ({
    seatId: row.id,
    venueSeatId: row.venueSeatId,
    status: row.status,
  }));
}

export function parseCachedSeatStatuses(cached: string): SeatStatusEntry[] {
  return JSON.parse(cached) as SeatStatusEntry[];
}
