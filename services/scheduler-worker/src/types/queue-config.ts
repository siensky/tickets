/**
 * Shapes for the queue-admission job's own reads (docs/plan.md
 * "Väntrum"). Deliberately NOT imported from booking-api — each service
 * owns its own vertical slice (docs/rules.md §1, see also outbox-
 * repository.ts in both services, which likewise don't share code).
 */

export interface QueueConfig {
  readonly admissionRatePerMinute: number;
  readonly sessionInactivityMinutes: number;
}

export interface EventSalesWindow {
  readonly salesCloseAt: Date;
  readonly isAfterClose: boolean;
}
