/**
 * Liveness and readiness probes (docs/forsvar.md "Varför får
 * livenessProbe inte kontrollera beroenden?"). Liveness only proves the
 * process is alive — restarting it on a dependency hiccup would restart
 * every pod at once, exactly when the system is most stressed. Readiness
 * will check Postgres/Redis reachability once those clients exist
 * (Fas 2) — for now it stays honest and simply reports true.
 */
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', () => ({ status: 'ok' }));
}
