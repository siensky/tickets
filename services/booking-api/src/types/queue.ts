/**
 * Shapes shared between the queue repository, service, controller and
 * mapper (docs/plan.md "Väntrum"). Kept here instead of inline, same
 * reasoning as types/reservation.ts.
 */

export interface QueueConfig {
  readonly admissionRatePerMinute: number;
  readonly sessionInactivityMinutes: number;
  /** Tid att boka efter insläpp. Räknas från INSLÄPPET, inte från JOIN. */
  readonly bookingWindowMinutes: number;
  /** Direktinsläpp: så många per event får vara insläppta utan kö. 0 = alla köar. */
  readonly directAdmitLimit: number;
}

/** Försäljningsfönstret som det låg i databasen, med Postgres `now()` vid läsningen. */
export interface EventSalesWindowSnapshot {
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly dbNow: Date;
}

export interface EventSalesWindow {
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
  /** Sekunder kvar till `sales_close_at`, räknat av Postgres (0 om den redan passerats). */
  readonly secondsUntilClose: number;
}

export interface JoinQueueInput {
  readonly eventId: string;
}

export interface JoinQueueResult {
  readonly token: string;
  readonly eventId: string;
}

export type QueueStatusResult =
  | {
      readonly status: 'waiting';
      readonly position: number;
      readonly queueDepth: number;
      /** När klienten får fråga igen (services/queue-poll-interval.ts). */
      readonly nextPollSeconds: number;
    }
  | { readonly status: 'admitted' }
  | { readonly status: 'sales_closed' }
  | { readonly status: 'sold_out' }
  | { readonly status: 'not_found' };
