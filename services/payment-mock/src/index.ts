/**
 * Entrypoint for payment-mock — simulates the payment provider for load
 * testing (docs/plan.md "Betalning"): configurable latency, ~5% failures,
 * duplicate webhooks, and responses arriving after a reservation has
 * expired, all gated behind an HMAC signature like Stripe uses. That
 * chaos behaviour is implemented in Fas 3; this is the bare skeleton.
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

const SERVICE_NAME = 'payment-mock';

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

  const port = Number(process.env['PAYMENT_MOCK_PORT'] ?? 3002);
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
    console.error('payment-mock failed to start', error);
    process.exit(1);
  });
}
