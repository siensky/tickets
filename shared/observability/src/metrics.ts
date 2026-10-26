/**
 * Prometheus metrics primitives shared by every service (docs/plan.md
 * "Observability" — Prometheus scrapes GET /metrics on each pod, it does
 * not receive pushes). Each service wires these into its own Fastify
 * /metrics route; this module only owns the registry and the RED-method
 * metrics (request rate, errors, duration) common to all of them.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Re-exported so consuming services never need `prom-client` as a direct
// dependency just to type a Registry — the metrics library choice stays
// an implementation detail of this package.
export type { Registry } from 'prom-client';

export function createRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}

export interface HttpMetrics {
  readonly requestsTotal: Counter<'method' | 'route' | 'status'>;
  readonly requestDuration: Histogram<'method' | 'route' | 'status'>;
}

/** RED method: Rate (requestsTotal), Errors (status label), Duration (requestDuration). */
export function createHttpMetrics(registry: Registry): HttpMetrics {
  const requestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests received',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return { requestsTotal, requestDuration };
}

export interface OversellMetrics {
  readonly oversellPreventedTotal: Counter<never>;
}

/**
 * docs/plan.md "Observability": increments when an INSERT into `tickets` fails on its
 * `(event_id, seat_id)` unique-violation — proof the database stopped an oversold seat.
 * A counter for "oversold" would be a tautology (the constraint makes that outcome
 * impossible), so this is the only honest metric for the guarantee.
 */
export function createOversellMetrics(registry: Registry): OversellMetrics {
  const oversellPreventedTotal = new Counter({
    name: 'oversell_prevented_total',
    help: 'Ticket inserts rejected by the tickets_valid_seat_unique constraint',
    registers: [registry],
  });
  return { oversellPreventedTotal };
}

export interface BusinessMetrics {
  readonly activeReservations: Gauge<'event_id'>;
  readonly soldTickets: Gauge<'event_id'>;
  readonly waitingRoomDepth: Gauge<'event_id'>;
  readonly queueJoinsTotal: Counter<'event_id'>;
  readonly queueAdmissionsTotal: Counter<'event_id'>;
}

/**
 * docs/plan.md "Vad som mäts" → "Affär": aktiva reservationer, ködjup,
 * insläppstakt, sålda biljetter, konverteringsgrad (den sista
 * beräknas i Grafana som `soldTickets / queueJoinsTotal`, ingen egen
 * metrik behövs för den). Saknades helt fram till Fas 6 (bara RED,
 * `oversell_prevented_total` och RabbitMQs eget `rabbitmq_queue_messages_ready`
 * fanns) — se docs/phase-status.md "Läget efter Fas 4".
 *
 * `activeReservations`/`soldTickets` är Gauges, inte Counters: en
 * reservation kan gå tillbaka till "ingen" (expired/cancelled) och en
 * biljett kan återbetalas (`refunded`) — antalet kan alltså MINSKA,
 * vilket en Counter per definition inte får göra. Satta periodiskt från
 * en riktig COUNT-fråga (services/scheduler-worker/src/services/
 * business-metrics-service.ts), inte vid varje enskild transition — en
 * liten eftersläpning (några sekunder) är ett bättre pris än att tråda
 * ett metrik-anrop genom varje ställe en reservation/biljett ändrar
 * status.
 */
export function createBusinessMetrics(registry: Registry): BusinessMetrics {
  const activeReservations = new Gauge({
    name: 'active_reservations',
    help: 'Reservations currently in status active or pending_payment, per event',
    labelNames: ['event_id'] as const,
    registers: [registry],
  });
  const soldTickets = new Gauge({
    name: 'sold_tickets',
    help: 'Tickets currently in status valid, per event',
    labelNames: ['event_id'] as const,
    registers: [registry],
  });
  const waitingRoomDepth = new Gauge({
    name: 'waiting_room_depth',
    help: "Remaining members in the waiting room's ZSET, per event",
    labelNames: ['event_id'] as const,
    registers: [registry],
  });
  const queueJoinsTotal = new Counter({
    name: 'queue_joins_total',
    help: 'Successful POST /queue/join calls, per event',
    labelNames: ['event_id'] as const,
    registers: [registry],
  });
  const queueAdmissionsTotal = new Counter({
    name: 'queue_admissions_total',
    help: 'Queue tokens admitted out of the waiting room, per event',
    labelNames: ['event_id'] as const,
    registers: [registry],
  });
  return {
    activeReservations,
    soldTickets,
    waitingRoomDepth,
    queueJoinsTotal,
    queueAdmissionsTotal,
  };
}
