/**
 * Shapes for the per-event, per-section seat status (docs/plan.md
 * "Realtid": "Stolarnas status | Polling var 2:a sekund mot
 * Redis-cache"). Deliberately separate from venue geometry
 * (types/venue.ts) — status lives on the sharded `seats` table, keyed
 * by `event_id`, while geometry lives on the global `venue_seats` table
 * and never changes per event.
 */

export type SeatStatus = 'available' | 'held' | 'sold';

export interface SeatStatusRow {
  readonly id: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
}

export interface SeatStatusEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
}
