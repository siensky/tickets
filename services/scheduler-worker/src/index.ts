/**
 * Entrypoint for scheduler-worker. Runs a minimal HTTP server (health +
 * metrics only — Kubernetes probes need an httpGet target even for a
 * background worker) alongside the two scheduling jobs this worker owns
 * (docs/plan.md "Databas"/"Idempotens"): releasing expired reservations
 * with jitter, and relaying the transactional outbox to RabbitMQ.
 *
 * replicas MUST stay at exactly 1 (see src/services/heartbeat.ts) — both
 * jobs would double their effect with a second copy running.
 */
import { closeShardPools, createShardPools } from '@tickets/db';
import { createHttpMetrics, createLogger, createRegistry } from '@tickets/observability';
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
import { startHeartbeat } from './services/heartbeat.js';
import { startOutboxRelay } from './services/outbox-relay-service.js';
import { startReservationReleaseJob } from './services/reservation-release-service.js';

const SERVICE_NAME = 'scheduler-worker';

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

  const port = Number(process.env['SCHEDULER_WORKER_PORT'] ?? 3010);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const heartbeat = startHeartbeat(logger);
  const shardPools = createShardPools();
  const reservationRelease = startReservationReleaseJob(shardPools, logger);
  const outboxRelay = startOutboxRelay(
    shardPools,
    process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
    logger,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(heartbeat);
    clearInterval(reservationRelease);
    await app.close();
    await outboxRelay.stop();
    await closeShardPools(shardPools);
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
    console.error('scheduler-worker failed to start', error);
    process.exit(1);
  });
}
