/**
 * Converts the pieces the reservation repository returns into the
 * shape the service hands back (docs/rules.md §1: mappers do the
 * database-row ↔ API-object conversion, nothing else).
 */
import type { ReservationResult } from '../types/reservation.js';

export function toReservationResult(params: {
  reservationId: string;
  eventId: string;
  queueTokenId: string;
  seatIds: readonly string[];
  expiresAt: Date;
}): ReservationResult {
  return {
    reservationId: params.reservationId,
    eventId: params.eventId,
    queueTokenId: params.queueTokenId,
    seatIds: params.seatIds,
    status: 'active',
    expiresAt: params.expiresAt.toISOString(),
  };
}

/**
 * Narrows a replayed idempotency response (stored as untyped JSONB)
 * back to `ReservationResult`. `as` used here, not elsewhere, per
 * docs/rules.md §2 — the shape was written by `toReservationResult`
 * itself a moment (or a retry-window) earlier, so trusting it back is
 * the same contract the DB column already enforces (jsonb, written by
 * this one call site).
 */
export function parseReplayedReservationResult(responseBody: unknown): ReservationResult {
  return responseBody as ReservationResult;
}
