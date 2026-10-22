/**
 * Entrypoint for payment-mock — simulates the payment provider for load
 * testing (docs/plan.md "Betalning"): configurable latency, ~5% failures,
 * duplicate webhooks, and responses arriving after a reservation has
 * expired, all gated behind an HMAC signature like Stripe uses. The
 * `stripe` Node SDK itself is pointed at this service during a load test
 * (booking-api's `STRIPE_HOST`/`STRIPE_PORT`, see services/stripe-
 * client.ts) — so it POSTs `application/x-www-form-urlencoded`, Stripe's
 * own wire format, not JSON. Fastify has no built-in parser for that
 * content type, and @fastify/formbody is a new dependency not approved
 * — this file registers a tiny one itself.
 */
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
import { registerCheckoutSessionsRoutes } from './routes/checkout-sessions.js';
import { registerRefundsRoutes } from './routes/refunds.js';
import { loadChaosConfig } from './services/chaos-config.js';
import { createSessionStore } from './services/session-store.js';

const SERVICE_NAME = 'payment-mock';
const FORM_URLENCODED = 'application/x-www-form-urlencoded';

export async function start(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  const registry = createRegistry(SERVICE_NAME);
  const httpMetrics = createHttpMetrics(registry);

  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({ loggerInstance: logger });
  app.addContentTypeParser(FORM_URLENCODED, { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  registerHealthRoutes(app);
  registerMetricsRoutes(app, registry);
  registerCheckoutSessionsRoutes(app, {
    sessionStore: createSessionStore(),
    chaosConfig: loadChaosConfig(),
    webhookUrl:
      process.env['BOOKING_API_WEBHOOK_URL'] ?? 'http://localhost:3000/webhooks/stripe',
    webhookSecret: process.env['STRIPE_WEBHOOK_SECRET'] ?? '',
    checkoutBaseUrl:
      process.env['PAYMENT_MOCK_CHECKOUT_BASE_URL'] ?? 'http://localhost:3002/mock-checkout',
    logger,
  });
  registerRefundsRoutes(app);

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    httpMetrics.requestsTotal.inc({ method: request.method, route, status });
    httpMetrics.requestDuration.observe(
      { method: request.method, route, status },
      reply.elapsedTime / 1000,
    );
  });

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
    console.error('payment-mock failed to start', error);
    process.exit(1);
  });
}
