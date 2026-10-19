/**
 * Entrypoint for notification-worker. Runs a minimal HTTP server (health +
 * metrics — including the RabbitMQ queue-depth metric KEDA scales on,
 * added in Fas 3) alongside the RabbitMQ consumer loop.
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
import { startHeartbeat } from './services/heartbeat.js';

const SERVICE_NAME = 'notification-worker';

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

  const port = Number(process.env['NOTIFICATION_WORKER_PORT'] ?? 3011);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const heartbeat = startHeartbeat(logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(heartbeat);
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
    console.error('notification-worker failed to start', error);
    process.exit(1);
  });
}
