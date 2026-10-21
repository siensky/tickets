/**
 * Pure decisions over already-locked seat rows (docs/plan.md
 * "Concurrency-kärnan"). No SQL and no I/O here — whether a given row
 * is still unavailable after lazy expiry is a plain data question once
 * `expireReservations` has told us which reservation ids Postgres
 * actually flipped to `expired`.
 */
import { ValidationError } from '@tickets/domain';
import type { SeatLockRow } from '../types/reservation.js';

/** Every distinct reservation currently holding one of the requested seats — expiry candidates. */
export function findHeldReservationIds(seatRows: readonly SeatLockRow[]): string[] {
  const ids = new Set<string>();
  for (const row of seatRows) {
    if (row.seatStatus === 'held' && row.reservationId !== null) {
      ids.add(row.reservationId);
    }
  }
  return [...ids];
}

/** Seat ids still unavailable after `expiredReservationIds` have been released. */
export function findUnavailableSeatIds(
  seatRows: readonly SeatLockRow[],
  expiredReservationIds: readonly string[],
): string[] {
  const expired = new Set(expiredReservationIds);
  return seatRows
    .filter((row) => {
      if (row.seatStatus === 'available') {
        return false;
      }
      if (
        row.seatStatus === 'held' &&
        row.reservationId !== null &&
        expired.has(row.reservationId)
      ) {
        return false;
      }
      return true;
    })
    .map((row) => row.seatId);
}

export function validateSeatCount(
  seatIds: readonly string[],
  maxSeatsPerReservation: number,
): void {
  if (seatIds.length === 0) {
    throw new ValidationError('At least one seat is required');
  }
  if (seatIds.length > maxSeatsPerReservation) {
    throw new ValidationError(`At most ${maxSeatsPerReservation} seats per reservation`, {
      requested: seatIds.length,
      max: maxSeatsPerReservation,
    });
  }
  if (new Set(seatIds).size !== seatIds.length) {
    throw new ValidationError('Duplicate seat ids in the same reservation request', {
      seatIds,
    });
  }
}
