/** See services/booking-api/src/routes/metrics.ts for the full rationale. */
import type { Registry } from '@tickets/observability';
import type { FastifyInstance } from 'fastify';

export function registerMetricsRoutes(app: FastifyInstance, registry: Registry): void {
  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
