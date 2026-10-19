/**
 * Prometheus metrics primitives shared by every service (docs/plan.md
 * "Observability" — Prometheus scrapes GET /metrics on each pod, it does
 * not receive pushes). Each service wires these into its own Fastify
 * /metrics route; this module only owns the registry and the RED-method
 * metrics (request rate, errors, duration) common to all of them.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
