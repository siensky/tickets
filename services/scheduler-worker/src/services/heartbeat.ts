/**
 * Placeholder for the two scheduling jobs this worker owns (docs/plan.md
 * "Concurrency-kärnan" / "Väntrum"): admitting the next batch from the
 * waiting-room queue, and releasing expired reservations with jitter.
 *
 * MUST run as exactly one replica (docs/forsvar.md "Varför två separata
 * workers?") — three copies would admit three times as many people.
 * Implemented in Fas 2/3. For now it only proves the process stays alive.
 */
import type { Logger } from '@tickets/observability';

export function startHeartbeat(logger: Logger, intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    logger.debug('scheduler-worker heartbeat');
  }, intervalMs);
}
