/**
 * Shapes for the queue-admission job's own reads (docs/plan.md
 * "Väntrum"). Deliberately NOT imported from booking-api — each service
 * owns its own vertical slice (docs/rules.md §1, see also outbox-
 * repository.ts in both services, which likewise don't share code).
 *
 * `sessionTotalMinutes` added in Fas 6 (Fas 3-reviewns notering):
 * `admitNextBatch` needs it to recognize an already-expired ZSET entry
 * BEFORE marking it admitted, so a deep backlog doesn't waste the
 * admission quota on dead sessions. Computed the same way the token's
 * own `exp` was at JOIN (shared/auth/src/queue-token.ts) — the ZSET
 * score IS the join time, so this stays a pure recomputation, no JWT
 * decoding needed.
 */

export interface QueueConfig {
  readonly admissionRatePerMinute: number;
  readonly sessionInactivityMinutes: number;
  readonly sessionTotalMinutes: number;
}

export interface EventSalesWindow {
  readonly salesCloseAt: Date;
  readonly isAfterClose: boolean;
}
