/**
 * Entrypoint for booking-api. Boots a bare Fastify instance with health
 * and metrics routes wired up — the walking-skeleton shape Fas 1 deploys
 * to api.<domän> (docs/forsvar.md "Varför infrastruktur först"). The
 * actual booking endpoints (reservations, orders, payments) are added in
 * Fas 2 under src/routes/, following the same registerXRoutes pattern.
 *
 * Zero-downtime deploys need graceful shutdown on the application side
 * too, not just Kubernetes config (docs/forsvar.md "Varför kräver
 * zero-downtime fyra saker?") — on SIGTERM this stops accepting new
 * connections and waits for in-flight requests to finish before exiting.
 */
import { createHttpMetrics, createLogger, createRegistry } from '@tickets/observability';
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';

const SERVICE_NAME = 'booking-api';

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  createHttpMetrics(registry);

  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({ loggerInstance: logger });

  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);

  const port = Number(process.env['BOOKING_API_PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  start().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- logger isn't guaranteed to exist if start() failed early
    console.error('booking-api failed to start', error);
    process.exit(1);
  });
}
