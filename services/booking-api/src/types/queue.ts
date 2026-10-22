/**
 * Shapes shared between the queue repository, service, controller and
 * mapper (docs/plan.md "Väntrum"). Kept here instead of inline, same
 * reasoning as types/reservation.ts.
 */

export interface QueueConfig {
  readonly admissionRatePerMinute: number;
  readonly sessionTotalMinutes: number;
  readonly sessionInactivityMinutes: number;
}

export interface EventSalesWindow {
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
}

export interface JoinQueueInput {
  readonly eventId: string;
}

export interface JoinQueueResult {
  readonly token: string;
  readonly eventId: string;
}

export type QueueStatusResult =
  | { readonly status: 'waiting'; readonly position: number; readonly queueDepth: number }
  | { readonly status: 'admitted' }
  | { readonly status: 'sales_closed' }
  | { readonly status: 'not_found' };
