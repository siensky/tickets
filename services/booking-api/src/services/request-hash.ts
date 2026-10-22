/**
 * Stable hash of a reservation request, used to detect when an
 * idempotency key is reused with a genuinely different request body
 * (docs/rules.md §5: `IdempotencyConflictError`). Seat ids are sorted
 * first so `[5, 9]` and `[9, 5]` hash identically — they're the same
 * request, just submitted in a different order.
 */
import { createHash } from 'node:crypto';
import type { CreateCheckoutInput } from '../types/payment.js';
import type { ReserveSeatsInput } from '../types/reservation.js';

export function computeRequestHash(input: ReserveSeatsInput): string {
  const normalized = {
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    seatIds: [...input.seatIds].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function computeCheckoutRequestHash(input: CreateCheckoutInput): string {
  const normalized = {
    eventId: input.eventId,
    reservationId: input.reservationId,
    queueTokenId: input.queueTokenId,
    auth0Sub: input.auth0Sub,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Deterministic order id for a reservation's checkout. Must be stable
 * across retries of the SAME checkout (same reservationId) — a random
 * id here would change Stripe's request body (it's embedded in
 * `metadata`) on every retry, and Stripe rejects reusing an
 * idempotency key with different parameters for 24h. Not a secret
 * (order ids already appear in API responses, unlike `qr_token`), so a
 * plain hash is enough — no HMAC secret needed.
 */
export function deriveOrderId(reservationId: string): string {
  const hex = createHash('sha256').update(`order:${reservationId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
