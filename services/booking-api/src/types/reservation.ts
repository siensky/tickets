/**
 * Shapes shared between the reservation repository, service, and mapper
 * (docs/plan.md "Concurrency-kärnan"). Kept here instead of inline so
 * none of the three layers has to import from one of the others' files.
 */

export interface ReservationConfig {
  readonly holdMinutes: number;
  readonly releaseJitterMaxSeconds: number;
  readonly maxSeatsPerReservation: number;
}

/** One row from locking the requested seats. */
export interface SeatLockRow {
  readonly seatId: string;
  readonly seatStatus: string;
  readonly reservationId: string | null;
}

export interface SeatLockOutcome {
  /** Seats this call actually acquired a `FOR UPDATE` lock on. */
  readonly locked: readonly SeatLockRow[];
  /** Seats that exist but failed `NOWAIT` — someone else holds them right now. */
  readonly lockFailedSeatIds: readonly string[];
}

export interface InsertedReservation {
  readonly id: string;
  readonly expiresAt: Date;
  readonly releaseAfter: Date;
}

export interface ReserveSeatsInput {
  readonly eventId: string;
  readonly seatIds: readonly string[];
  readonly queueTokenId: string;
  readonly idempotencyKey: string;
}

export interface ReservationResult {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly seatIds: readonly string[];
  readonly status: 'active';
  readonly expiresAt: string;
}

export type ReservationStatus =
  'active' | 'pending_payment' | 'converted' | 'expired' | 'cancelled';

export interface ReservationSeatDetailRow {
  readonly seatId: string;
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
  readonly priceCents: number;
}

export interface ReservationSeatView {
  readonly seatId: string;
  readonly sectionId: string;
  readonly sectionName: string;
  readonly row: string;
  readonly number: number;
  readonly priceCents: number;
}

/** The read shape for `GET /reservations/:id` — unlike `ReservationResult`, status can be anything the row currently holds. */
export interface ReservationView {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly status: ReservationStatus;
  readonly expiresAt: string;
  readonly seatIds: readonly string[];
  readonly seats: readonly ReservationSeatView[];
  readonly totalCents: number;
  readonly currency: 'SEK';
}

export interface ReservationWithSeatsRow {
  readonly id: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly status: ReservationStatus;
  readonly expiresAt: Date;
  readonly seatIds: readonly string[];
}
