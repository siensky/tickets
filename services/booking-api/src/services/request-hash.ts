/**
 * Stable hash of a reservation request, used to detect when an
 * idempotency key is reused with a genuinely different request body
 * (docs/rules.md §5: `IdempotencyConflictError`). Seat ids are sorted
 * first so `[5, 9]` and `[9, 5]` hash identically — they're the same
 * request, just submitted in a different order.
 */
import { createHash } from 'node:crypto';
import type { ReserveSeatsInput } from '../types/reservation.js';

export function computeRequestHash(input: ReserveSeatsInput): string {
  const normalized = {
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    seatIds: [...input.seatIds].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
