/**
 * Entrypoint for notification-worker. Runs a minimal HTTP server (health +
 * metrics — including the RabbitMQ queue-depth metric KEDA scales on,
 * added in Fas 3) alongside the RabbitMQ consumer loop for
 * `order.confirmed`/`order.refunded` (docs/plan.md "Tjänster").
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
import { startHeartbeat } from './services/heartbeat.js';
import { processNotificationEvent } from './services/notification-consumer-service.js';
import {
  createQueueDepthGauge,
  startQueueDepthPoll,
  type QueueDepthPoll,
} from './services/queue-depth-metric.js';

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
    queueDepthPoll: QueueDepthPoll;
  },
): (signal: string) => void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    clearInterval(resources.heartbeat);
    await resources.app.close();
    await resources.consumer.close();
    await resources.queueDepthPoll.stop();
    await closeShardPools(resources.shardPools);
    await closeRedisClient(resources.redis);
    process.exit(0);
  };
  return (signal: string): void => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ signal, error }, 'error during graceful shutdown');
      process.exit(1);
    });
  };
}

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  const httpMetrics = createHttpMetrics(registry);
  const queueDepthGauge = createQueueDepthGauge(registry);

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

  const heartbeat = startHeartbeat(logger);
  const shardPools = createShardPools({
    onShardError: (shardIndex, error) => {
      logger.warn({ shardIndex, error }, 'shard connection error');
    },
  });
  const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const rabbitUrl = process.env['RABBITMQ_URL'] ?? 'amqp://localhost';

  const consumer = await connectConsumer(
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
  const queueDepthPoll = await startQueueDepthPoll(
    rabbitUrl,
    ORDER_EVENTS_QUEUE,
    queueDepthGauge,
    logger,
  );

  const shutdownOrCrash = createShutdownHandler(logger, {
    app,
    heartbeat,
    shardPools,
    redis,
    consumer,
    queueDepthPoll,
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
