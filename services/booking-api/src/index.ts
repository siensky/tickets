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

const SERVICE_NAME = 'booking-api';

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

  const port = Number(process.env['BOOKING_API_PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `${SERVICE_NAME} listening`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down gracefully');
    await app.close();
    process.exit(0);
  };
  const shutdownOrCrash = (signal: string): void => {
    shutdown(signal).catch((error: unknown) => {
      // `void shutdown(...)` alone leaves a rejection here unhandled,
      // which crashes the process via Node's default behaviour — same
      // end result, but with a raw stack trace instead of a log line.
      logger.error({ signal, error }, 'error during graceful shutdown');
      process.exit(1);
    });
  };
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
