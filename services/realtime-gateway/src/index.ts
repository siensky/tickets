/**
 * Entrypoint for realtime-gateway. Separate service from booking-api so
 * a booking-api deploy never drops WebSocket connections (docs/forsvar.md
 * "Varför är WebSocket-gatewayen en egen tjänst?").
 */
import websocketPlugin from '@fastify/websocket';
import { createQueueTokenSecret } from '@tickets/auth';
import { createHttpMetrics, createLogger, createRegistry } from '@tickets/observability';
import { closeRedisClient, createRedisClient } from '@tickets/redis';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  // RED-metriken (createHttpMetrics) registrerades i registret men
  // ingenting ökade dem — de hade stått still på noll för alltid, vilket
  // är SÄMRE än att sakna dem helt: i Fas 4 bygger Grafana-paneler på
  // dem, och en platt nolla läser som "ingen trafik" i stället för "inte
  // instrumenterat". routeOptions.url (inte den råa, dynamiska URL:en)
  // håller kardinaliteten nere — en path med :id i hade annars gett en
  // egen tidsserie per unikt ID.
  const httpMetrics = createHttpMetrics(registry);

  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({ loggerInstance: logger });
  await app.register(websocketPlugin);

  const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const queueTokenSecret = createQueueTokenSecret(requireEnv('QUEUE_TOKEN_SECRET'));

  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    httpMetrics.requestsTotal.inc({ method: request.method, route, status });
    httpMetrics.requestDuration.observe(
      { method: request.method, route, status },
      reply.elapsedTime / 1000,
    );
  });
  registerWsRoute(app, { redis, queueTokenSecret });

  const port = Number(process.env['REALTIME_GATEWAY_PORT'] ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    await app.close();
    await closeRedisClient(redis);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// process.argv[1] skrivs INTE symlänk-upplöst, medan import.meta.url
// skrivs det — och är dessutom procentkodad. De två kan därför skilja
// sig åt trots att det ÄR samma fil (verifierat: skiljer sig redan på
// en symlänk till en sökväg utanför /tmp på macOS). I avbyggnadsimagen
// (WORKDIR /app, CMD ["node","dist/index.js"]) råkar de matcha i dag —
// men går de isär tyst avslutas processen med kod 0, utan ett enda
// loggutrymme, och podden startas om i evighet utan diagnostik.
// realpathSync + fileURLToPath normaliserar båda sidor på samma sätt.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  start().catch((error: unknown) => {
    // eslint-disable-next-line no-console -- logger isn't guaranteed to exist if start() failed early
    console.error('realtime-gateway failed to start', error);
    process.exit(1);
  });
}
