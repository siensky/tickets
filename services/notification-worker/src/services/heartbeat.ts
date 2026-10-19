/**
 * Placeholder for the RabbitMQ consumer this worker will run (docs/plan.md
 * "Idempotens" — order confirmation emails, QR generation, push to the
 * scanner app, all off the critical purchase path). Scales 1-10 on
 * RabbitMQ queue depth via KEDA (docs/forsvar.md "Varför KEDA och inte
 * bara HPA?"), unlike scheduler-worker which must stay at replicas: 1.
 * Implemented in Fas 3.
 */
import type { Logger } from '@tickets/observability';

export function startHeartbeat(logger: Logger, intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    logger.debug('notification-worker heartbeat');
  }, intervalMs);
}
