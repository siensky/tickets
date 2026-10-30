/**
 * Säljstatus för events och sektioner (docs/plan.md 7.13 E1/E2). Regeln
 * ligger bara här i backend; UI:t speglar `availability` och räknar aldrig
 * själv. `isBeforeOpen`/`isAfterClose` är Postgres-beräknade (`now()`,
 * docs/rules.md §4), så ingen klocka i appservern är inblandad.
 */
import type { EventAvailability, EventRow } from '../types/event.js';

const FEW_LEFT_MIN_SEATS = 10;
const FEW_LEFT_FRACTION = 0.1;

export type SeatAvailability = Extract<EventAvailability, 'sold_out' | 'few_left' | 'on_sale'>;

/** Gränsen för "få kvar": max(10, 10 % av stolarna), uppåt avrundat. */
export function computeSeatAvailability(
  availableSeats: number,
  totalSeats: number,
): SeatAvailability {
  if (availableSeats === 0) {
    return 'sold_out';
  }
  const threshold = Math.max(FEW_LEFT_MIN_SEATS, Math.ceil(totalSeats * FEW_LEFT_FRACTION));
  return availableSeats <= threshold ? 'few_left' : 'on_sale';
}

export function computeAvailability(
  row: Pick<
    EventRow,
    'status' | 'isBeforeOpen' | 'isAfterClose' | 'availableSeats' | 'totalSeats'
  >,
): EventAvailability {
  if (row.status !== 'scheduled' || row.isAfterClose) {
    return 'closed';
  }
  if (row.isBeforeOpen) {
    return 'opens_soon';
  }
  return computeSeatAvailability(row.availableSeats, row.totalSeats);
}
