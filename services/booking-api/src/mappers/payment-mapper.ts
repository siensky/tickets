/**
 * Database-row ↔ API-object conversion for the payment flow
 * (docs/rules.md §1).
 */
import type { CreateCheckoutResult } from '../types/payment.js';

/**
 * Narrows a replayed idempotency response back to `CreateCheckoutResult`
 * — same reasoning as `parseReplayedReservationResult` (docs/rules.md
 * §2): the shape was written by this exact call site a moment earlier.
 */
export function parseReplayedCheckoutResult(responseBody: unknown): CreateCheckoutResult {
  return responseBody as CreateCheckoutResult;
}
