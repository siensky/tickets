/**
 * Typad PostHog-händelsekatalog — den enda källan till händelsenamn och props (docs/plan.md 7.7).
 * Används av apps/web, apps/scanner och ./server.ts. Händelsenamnen får aldrig skrivas som
 * lösa strängar vid anropsplatsen: tratten går inte att analysera om namnen glider isär.
 *
 * `createTracker(null)` gör ingenting: lokalt, i CI och i tester finns ingen nyckel, och då
 * ska analytics aldrig kunna orsaka fel eller nätverkstrafik.
 */

/** Props som nästan alla klienthändelser delar. */
export interface EventContext {
  readonly event_id: string;
  readonly category: string;
}

export interface ChallengeContext {
  readonly event_id: string;
  readonly challenge_type: 'pow' | 'turnstile';
}

/** `aborted` = avbröt hos Stripe; `cancelled` = ordern annullerades efter återbetalning. */
export type CheckoutReturnStatus = 'paid' | 'refunded' | 'cancelled' | 'timeout' | 'aborted';

export type ScanResultName = 'ok' | 'already_scanned' | 'not_found' | 'refunded' | 'void';

export type ClientEvents = {
  readonly event_viewed: EventContext;
  readonly search_performed: Record<string, never>;
  readonly category_filtered: { readonly category: string };
  readonly queue_joined: EventContext;
  /** Botskyddet (docs/plan.md 8.5): `queue/join` svarade 428. `pow` löses osynligt, `turnstile` syns. */
  readonly challenge_shown: ChallengeContext;
  readonly challenge_passed: ChallengeContext;
  readonly queue_admitted: EventContext & { readonly wait_seconds: number };
  readonly queue_left: EventContext & { readonly wait_seconds: number };
  readonly seats_selected: EventContext & { readonly seat_count: number };
  readonly reservation_created: EventContext & { readonly seat_count: number };
  readonly checkout_started: EventContext & { readonly total_sek: number };
  readonly checkout_returned: EventContext & { readonly status: CheckoutReturnStatus };
  readonly ticket_viewed: EventContext;
};

export type ServerEvents = {
  readonly payment_succeeded: {
    readonly order_id: string;
    readonly event_id: string;
    readonly seat_count: number;
    readonly total_sek: number;
  };
  readonly payment_late_refunded: { readonly order_id: string; readonly event_id: string };
  readonly reservation_expired: { readonly event_id: string };
  readonly ticket_scanned: { readonly result: ScanResultName; readonly gate: string };
};

export interface AnalyticsSink {
  capture(name: string, props: object): void;
}

export interface Tracker<Events> {
  track<Name extends keyof Events & string>(name: Name, props: Events[Name]): void;
}

export function createTracker<Events extends Record<string, object>>(
  sink: AnalyticsSink | null,
): Tracker<Events> {
  return {
    track(name, props) {
      sink?.capture(name, { ...props });
    },
  };
}
