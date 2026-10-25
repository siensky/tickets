/**
 * Preloaded via `node --import` (package.json "dev"/"start", Dockerfile CMD) — see
 * shared/observability/src/tracing.ts for why this can't just be a normal import at
 * the top of index.ts.
 */
import { startTracing } from '@tickets/observability/tracing';

const tracing = startTracing('notification-worker');

export function shutdownTracing(): Promise<void> {
  return tracing.shutdown();
}
