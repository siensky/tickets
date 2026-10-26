/**
 * Entrypoint for booking-api — the Fastify HTTP API for the booking
 * transaction (docs/plan.md "Tjänster"). Fas 3 wires the real queue,
 * reservation and payment endpoints behind queue-token/Auth0 auth and
 * rate limiting, plus the RabbitMQ consumer that converts a paid
 * reservation into an order and tickets.
 *
 * Zero-downtime deploys need graceful shutdown on the application side
 * too, not just Kubernetes config (docs/forsvar.md "Varför kräver
 * zero-downtime fyra saker?") — on SIGTERM this stops accepting new
 * connections, waits for in-flight requests to finish, then closes every
 * connection pool, before exiting.
 */
import {
  createAuth0Verifier,
  createQueueTokenSecret,
  type Auth0Verifier,
} from '@tickets/auth';
import { closeShardPools, createShardPools, type ShardPools } from '@tickets/db';
import {
  createHttpMetrics,
  createLogger,
  createOversellMetrics,
  createRegistry,
  type HttpMetrics,
  type Logger,
  type OversellMetrics,
} from '@tickets/observability';
import { closeRedisClient, createRedisClient, type RedisClient } from '@tickets/redis';
import { connectConsumer, type RabbitConsumer } from '@tickets/rabbit';
import { OUTBOX_EVENT_TYPES, OUTBOX_EXCHANGE } from '@tickets/domain';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { registerCheckoutRoutes } from './routes/checkout.js';
import { registerCors } from './routes/cors.js';
import { registerErrorHandler } from './routes/error-handler.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerMyTicketsRoutes } from './routes/my-tickets.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerRateLimitHook } from './routes/rate-limit.js';
import { registerReservationRoutes } from './routes/reservations.js';
import { registerSeatMarkRoutes } from './routes/seat-marks.js';
import { registerSeatmapRoutes } from './routes/seatmap.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { shutdownTracing } from './instrumentation.js';
import { createStripeClient } from './services/stripe-client.js';
import {
  parsePaymentSucceededPayload,
  processPaymentSucceeded,
} from './services/payment-consumer-service.js';
import './types/request-context.js';

const SERVICE_NAME = 'booking-api';
const PAYMENT_CONSUMER_QUEUE = 'booking-api.payment-succeeded';
const PAYMENT_CONSUMER_DELIVERY_LIMIT = 5;

type FastifyApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger
>;

function createApp(logger: Logger): FastifyApp {
  return Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({ loggerInstance: logger, trustProxy: true });
}

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

interface Dependencies {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly queueTokenSecret: ReturnType<typeof createQueueTokenSecret>;
  readonly auth0Verifier: Auth0Verifier;
  readonly stripeSecretKey: string;
  readonly qrTokenSecret: string;
  readonly paymentFrozenMinutes: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly rateLimitPerSecond: number;
}

/**
 * `STRIPE_HOST`/`STRIPE_PORT` är avsiktligt separata från
 * `STRIPE_SECRET_KEY` — tomma i produktion (riktiga Stripe), satta till
 * `payment-mock` under lasttest (docs/plan.md "payment-mock för
 * lasttest"). services/stripe-client.ts kräver ingen kod-ändring för
 * att peka om sig.
 */
function createStripeClientFromEnv(secretKey: string): ReturnType<typeof createStripeClient> {
  const host = process.env['STRIPE_HOST'];
  const port = process.env['STRIPE_PORT'];
  return createStripeClient({
    secretKey,
    host,
    protocol: host === undefined ? undefined : 'http',
    port: port === undefined ? undefined : Number(port),
  });
}

function loadDependencies(logger: Logger): Dependencies {
  const shardPools = createShardPools({
    onShardError: (shardIndex, error) => {
      logger.warn({ shardIndex, error }, 'shard connection error');
    },
  });
  return {
    shardPools,
    logger,
    redis: createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379'),
    queueTokenSecret: createQueueTokenSecret(requireEnv('QUEUE_TOKEN_SECRET')),
    auth0Verifier: createAuth0Verifier({
      domain: requireEnv('AUTH0_DOMAIN'),
      audience: requireEnv('AUTH0_AUDIENCE'),
    }),
    stripeSecretKey: requireEnv('STRIPE_SECRET_KEY'),
    qrTokenSecret: requireEnv('QR_TOKEN_SECRET'),
    paymentFrozenMinutes: Number(process.env['PAYMENT_FROZEN_MINUTES'] ?? 10),
    successUrl: process.env['CHECKOUT_SUCCESS_URL'] ?? 'https://example.test/checkout/success',
    cancelUrl: process.env['CHECKOUT_CANCEL_URL'] ?? 'https://example.test/checkout/cancel',
    rateLimitPerSecond: Number(process.env['RATE_LIMIT_PER_SECOND'] ?? 50),
  };
}

function registerRoutes(
  app: FastifyApp,
  registry: Parameters<typeof registerMetricsRoutes>[1],
  deps: Dependencies,
  stripe: ReturnType<typeof createStripeClient>,
  logger: Logger,
): void {
  registerCors(app);
  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);
  registerErrorHandler(app);
  registerRateLimitHook(app, deps.redis, deps.rateLimitPerSecond, logger);
  registerEventRoutes(app, { shardPools: deps.shardPools, logger });
  registerSeatmapRoutes(app, { shardPools: deps.shardPools, redis: deps.redis, logger });
  registerQueueRoutes(app, deps);
  registerReservationRoutes(app, deps);
  registerSeatMarkRoutes(app, deps);
  registerCheckoutRoutes(
    app,
    {
      shardPools: deps.shardPools,
      redis: deps.redis,
      queueTokenSecret: deps.queueTokenSecret,
      logger,
      stripe,
      paymentFrozenMinutes: deps.paymentFrozenMinutes,
      successUrl: deps.successUrl,
      cancelUrl: deps.cancelUrl,
    },
    deps.auth0Verifier,
  );
  registerMyTicketsRoutes(app, { shardPools: deps.shardPools, logger }, deps.auth0Verifier);
  registerWebhookRoutes(app, {
    shardPools: deps.shardPools,
    stripe,
    webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
  });
}

async function startPaymentConsumer(
  deps: Dependencies,
  stripe: ReturnType<typeof createStripeClient>,
  logger: Logger,
  oversellMetrics: OversellMetrics,
): Promise<RabbitConsumer> {
  return connectConsumer(
    process.env['RABBITMQ_URL'] ?? 'amqp://localhost',
    {
      exchange: OUTBOX_EXCHANGE,
      queue: PAYMENT_CONSUMER_QUEUE,
      routingKey: OUTBOX_EVENT_TYPES.PAYMENT_SUCCEEDED,
      deliveryLimit: PAYMENT_CONSUMER_DELIVERY_LIMIT,
    },
    (payload, messageId) =>
      processPaymentSucceeded(
        {
          shardPools: deps.shardPools,
          stripe,
          qrTokenSecret: deps.qrTokenSecret,
          logger,
          oversellMetrics,
        },
        parsePaymentSucceededPayload(payload),
        messageId,
      ),
    (error, messageId) => {
      logger.warn(
        { error, messageId },
        'payment-succeeded consumer failed to process a message',
      );
    },
    (error) => {
      logger.warn({ error }, 'payment-succeeded consumer connection lost, reconnecting');
    },
  );
}

/**
 * Startar konsumenten UTAN att blockera `app.listen` (se anropsplatsen i
 * `start()`): är RabbitMQ nere vid boot ska HTTP-API:t fortfarande svara
 * — annars blockerar en nedgången mäklare hela podden från att bli redo,
 * vilket krockar med zero-downtime (Fas 6) och kronjuveltest 4
 * (docs/plan.md:431). Försöker om med backoff tills den lyckas eller
 * `state.stopped` sätts av `createShutdownHandler`.
 */
async function startPaymentConsumerWithRetry(
  deps: Dependencies,
  stripe: ReturnType<typeof createStripeClient>,
  logger: Logger,
  oversellMetrics: OversellMetrics,
  state: { consumer: RabbitConsumer | undefined; stopped: boolean },
): Promise<void> {
  let delayMs = 1000;
  while (!state.stopped) {
    try {
      state.consumer = await startPaymentConsumer(deps, stripe, logger, oversellMetrics);
      return;
    } catch (error) {
      logger.warn({ error }, 'payment-succeeded consumer failed to start, retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

function createShutdownHandler(
  logger: Logger,
  resources: {
    app: FastifyApp;
    deps: Dependencies;
    paymentConsumerState: { consumer: RabbitConsumer | undefined; stopped: boolean };
  },
): (signal: string) => void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    resources.paymentConsumerState.stopped = true;
    await resources.app.close();
    await resources.paymentConsumerState.consumer?.close();
    await closeShardPools(resources.deps.shardPools);
    await closeRedisClient(resources.deps.redis);
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

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  const httpMetrics = createHttpMetrics(registry);
  const oversellMetrics = createOversellMetrics(registry);
  const app = createApp(logger);
  const deps = loadDependencies(logger);
  const stripe = createStripeClientFromEnv(deps.stripeSecretKey);

  registerRoutes(app, registry, deps, stripe, logger);
  registerRedMetricsHook(app, httpMetrics);

  const paymentConsumerState: { consumer: RabbitConsumer | undefined; stopped: boolean } = {
    consumer: undefined,
    stopped: false,
  };
  void startPaymentConsumerWithRetry(
    deps,
    stripe,
    logger,
    oversellMetrics,
    paymentConsumerState,
  );

  const port = Number(process.env['BOOKING_API_PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const shutdownOrCrash = createShutdownHandler(logger, { app, deps, paymentConsumerState });
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
    console.error('booking-api failed to start', error);
    process.exit(1);
  });
}
