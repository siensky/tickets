/**
 * Entrypoint for realtime-gateway. Separate service from booking-api so
 * a booking-api deploy never drops WebSocket connections (docs/forsvar.md
 * "Varför är WebSocket-gatewayen en egen tjänst?").
 */
import websocketPlugin from '@fastify/websocket';
import { createHttpMetrics, createLogger, createRegistry } from '@tickets/observability';
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerWsRoute } from './routes/ws.js';

const SERVICE_NAME = 'realtime-gateway';

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
  await app.register(websocketPlugin);

  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);
  registerWsRoute(app);

  const port = Number(process.env['REALTIME_GATEWAY_PORT'] ?? 3001);
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
    console.error('realtime-gateway failed to start', error);
    process.exit(1);
  });
}
