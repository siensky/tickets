/**
 * Entrypoint for notification-worker. Runs a minimal HTTP server (health +
 * metrics) alongside the RabbitMQ consumer loop for
 * `order.confirmed`/`order.refunded` (docs/plan.md "Tjänster").
 *
 * Fas 3 built its own `rabbitmq_queue_messages_ready` gauge here as the KEDA
 * scaling signal (queue-depth-metric.ts, removed in Fas 4). Fas 4 enables
 * RabbitMQ's own `rabbitmq_prometheus` plugin (infra/k8s/base/rabbitmq) —
 * once that's scraped, a hand-rolled gauge of the same name is redundant and
 * actively misleading: the plugin reports the queue's real depth, the
 * hand-rolled one was one copy per pod and not summable across replicas.
 * The Fas 6 KEDA `ScaledObject` scales against the plugin's metric (or
 * RabbitMQ's management API directly) instead.
 */
import { closeShardPools, createShardPools, type ShardPools } from '@tickets/db';
import { OUTBOX_EXCHANGE } from '@tickets/domain';
import {
  createHttpMetrics,
  createLogger,
  createRegistry,
  type HttpMetrics,
  type Logger,
} from '@tickets/observability';
import { connectConsumer, type RabbitConsumer } from '@tickets/rabbit';
import { closeRedisClient, createRedisClient, type RedisClient } from '@tickets/redis';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { shutdownTracing } from './instrumentation.js';
import { startHeartbeat } from './services/heartbeat.js';
import { processNotificationEvent } from './services/notification-consumer-service.js';

const SERVICE_NAME = 'notification-worker';
const ORDER_EVENTS_QUEUE = 'notification-worker.order-events';
// Topic-wildcard — en bindning täcker BÅDE order.confirmed och
// order.refunded (docs/plan.md "Tjänster"), ingen anledning att
// deklarera två köer för samma konsument.
const ORDER_EVENTS_ROUTING_KEY = 'order.*';
const DELIVERY_LIMIT = 5;

type FastifyApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger
>;

function registerRedMetricsHook(app: FastifyApp, httpMetrics: HttpMetrics): void {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    httpMetrics.requestsTotal.inc({ method: request.method, route, status });
    httpMetrics.requestDuration.observe(
      { method: request.method, route, status },
      reply.elapsedTime / 1000,
    );
  });
}

function createShutdownHandler(
  logger: Logger,
  resources: {
    app: FastifyApp;
    heartbeat: NodeJS.Timeout;
    shardPools: ShardPools;
    redis: RedisClient;
    consumer: RabbitConsumer;
  },
): (signal: string) => void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(resources.heartbeat);
    await resources.app.close();
    await resources.consumer.close();
    await closeShardPools(resources.shardPools);
    await closeRedisClient(resources.redis);
    await shutdownTracing();
    process.exit(0);
  };
  return (signal: string): void => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ signal, error }, 'error during graceful shutdown');
      process.exit(1);
    });
  };
}

async function createAndStartHttpServer(
  logger: Logger,
  registry: ReturnType<typeof createRegistry>,
  httpMetrics: HttpMetrics,
): Promise<FastifyApp> {
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({ loggerInstance: logger });
  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);
  registerRedMetricsHook(app, httpMetrics);

  const port = Number(process.env['NOTIFICATION_WORKER_PORT'] ?? 3011);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);
  return app;
}

async function startNotificationConsumer(
  rabbitUrl: string,
  shardPools: ShardPools,
  redis: RedisClient,
  logger: Logger,
): Promise<RabbitConsumer> {
  return connectConsumer(
    rabbitUrl,
    {
      exchange: OUTBOX_EXCHANGE,
      queue: ORDER_EVENTS_QUEUE,
      routingKey: ORDER_EVENTS_ROUTING_KEY,
      deliveryLimit: DELIVERY_LIMIT,
    },
    (payload, messageId) =>
      processNotificationEvent({ shardPools, redis, logger }, payload, messageId),
    (error, messageId) => {
      logger.warn({ error, messageId }, 'notification consumer failed to process a message');
    },
  );
}

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  const httpMetrics = createHttpMetrics(registry);

  const app = await createAndStartHttpServer(logger, registry, httpMetrics);

  const heartbeat = startHeartbeat(logger);
  const shardPools = createShardPools({
    onShardError: (shardIndex, error) => {
      logger.warn({ shardIndex, error }, 'shard connection error');
    },
  });
  const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const rabbitUrl = process.env['RABBITMQ_URL'] ?? 'amqp://localhost';

  const consumer = await startNotificationConsumer(rabbitUrl, shardPools, redis, logger);

  const shutdownOrCrash = createShutdownHandler(logger, {
    app,
    heartbeat,
    shardPools,
    redis,
    consumer,
  });
  process.on('SIGTERM', () => shutdownOrCrash('SIGTERM'));
  process.on('SIGINT', () => shutdownOrCrash('SIGINT'));
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
    console.error('notification-worker failed to start', error);
    process.exit(1);
  });
}
