/**
 * Pure decisions over already-locked seat rows (docs/plan.md
 * "Concurrency-kärnan"). No SQL and no I/O here — whether a given row
 * is still unavailable after lazy expiry is a plain data question once
 * `releaseExpiredSeatsAmong` has told us which seat ids Postgres
 * actually freed.
 */
import { ValidationError } from '@tickets/domain';
import type { SeatLockRow } from '../types/reservation.js';

/** Seat ids still unavailable after `releasedSeatIds` have been freed by lazy expiry. */
export function findUnavailableSeatIds(
  lockedSeats: readonly SeatLockRow[],
  releasedSeatIds: readonly string[],
): string[] {
  const released = new Set(releasedSeatIds);
  return lockedSeats
    .filter((row) => row.seatStatus !== 'available' && !released.has(row.seatId))
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
