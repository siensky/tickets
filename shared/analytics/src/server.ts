/**
 * Server-side PostHog SDK wrapper. Kritiska konverteringshändelser (payment_succeeded) skickas
 * härifrån, inte från webbläsaren — en stängd flik får inte tappa händelsen (docs/forsvar.md,
 * docs/plan.md 7.7). Utan nyckel (lokalt, CI, lasttest med POSTHOG_ENABLED=false) är allt no-op.
 *
 * Fallgrop: `shutdown()` måste anropas i graceful shutdown, annars tappas de händelser som
 * ligger i PostHog-klientens buffert vid varje deploy.
 */
import { PostHog } from 'posthog-node';
import type { ServerEvents } from './index.js';

export interface ServerAnalytics {
  /** `distinctId` är Auth0 `sub` (eller en anonym id för personlösa händelser). Kastar aldrig. */
  track<Name extends keyof ServerEvents>(
    distinctId: string,
    name: Name,
    props: ServerEvents[Name],
    options?: { readonly personless?: boolean },
  ): void;
  shutdown(): Promise<void>;
}

export const NOOP_SERVER_ANALYTICS: ServerAnalytics = {
  track() {},
  async shutdown() {},
};

export interface ServerAnalyticsConfig {
  readonly apiKey: string | undefined;
  /** `false` slår av helt, även med nyckel (lasttest). Standard: på. */
  readonly enabled: boolean;
  readonly host?: string;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_HOST = 'https://eu.i.posthog.com';
// Kortare än podens terminationGracePeriodSeconds (30 s): svarar inte PostHog får det aldrig
// blockera resten av graceful shutdown (pooler, tracing).
const REQUEST_TIMEOUT_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 5000;

export function createServerAnalytics(config: ServerAnalyticsConfig): ServerAnalytics {
  if (!config.enabled || config.apiKey === undefined || config.apiKey === '') {
    return NOOP_SERVER_ANALYTICS;
  }
  const client = new PostHog(config.apiKey, {
    host: config.host ?? DEFAULT_HOST,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  client.on('error', (error: unknown) => config.onError?.(error));
  return {
    track(distinctId, name, props, options) {
      try {
        client.capture({
          distinctId,
          event: name,
          properties: {
            ...props,
            ...(options?.personless === true ? { $process_person_profile: false } : {}),
          },
        });
      } catch (error) {
        config.onError?.(error);
      }
    },
    async shutdown() {
      await client.shutdown(SHUTDOWN_TIMEOUT_MS);
    },
  };
}

/** Läser `POSTHOG_KEY` och `POSTHOG_ENABLED` (docs/plan.md 7.7: `false` under loadtest-mode on). */
export function createServerAnalyticsFromEnv(
  env: NodeJS.ProcessEnv,
  onError?: (error: unknown) => void,
): ServerAnalytics {
  return createServerAnalytics({
    apiKey: env['POSTHOG_KEY'],
    enabled: env['POSTHOG_ENABLED'] !== 'false',
    onError,
  });
}
