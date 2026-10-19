/**
 * Exposes GET /metrics for Prometheus to scrape (pull model, not push —
 * see docs/forsvar.md "Hur fungerar Prometheus egentligen?"). Prometheus
 * calls this endpoint every 15s; this service never sends metrics anywhere
 * itself.
 */
import type { Registry } from '@tickets/observability';
import type { FastifyInstance } from 'fastify';

export function registerMetricsRoutes(app: FastifyInstance, registry: Registry): void {
  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
