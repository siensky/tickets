/**
 * Byggs upp i en egen fil, inte i index.ts (docs/rules.md §11: 300
 * rader/fil-gränsen) — rena konstruktionsfunktioner, ingen Fastify-
 * routing eller livscykel här.
 */
import { createServerAnalyticsFromEnv, type ServerAnalytics } from '@tickets/analytics/server';
import {
  createAuth0Verifier,
  createQueueTokenSecret,
  type Auth0Verifier,
} from '@tickets/auth';
import { createShardPools, type ShardPools } from '@tickets/db';
import type { BusinessMetrics, Logger } from '@tickets/observability';
import { createRedisClient, type RedisClient } from '@tickets/redis';
import { createStripeClient } from './services/stripe-client.js';
import type { ChallengeDeps } from './services/challenge-service.js';
import { createPowKey } from './services/pow.js';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export interface Dependencies {
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
  readonly rateLimitAllowlistedIps: ReadonlySet<string>;
  readonly businessMetrics: BusinessMetrics;
  readonly publicAssetBaseUrl: string;
  readonly analytics: ServerAnalytics;
  /** `API_CACHE_MAX_AGE_SECONDS`: 0 = ingen cache (standard lokalt och i CI), annars TTL för eventlistan och cache-header på sektionssammanfattningen. */
  readonly apiCacheSeconds: number;
  /** Botskyddet på queue/join (docs/plan.md 8.5). */
  readonly challenge: ChallengeDeps;
}

/**
 * `STRIPE_HOST`/`STRIPE_PORT` är avsiktligt separata från
 * `STRIPE_SECRET_KEY` — tomma i produktion (riktiga Stripe), satta till
 * `payment-mock` under lasttest (docs/plan.md "payment-mock för
 * lasttest"). services/stripe-client.ts kräver ingen kod-ändring för
 * att peka om sig.
 */
export function createStripeClientFromEnv(
  secretKey: string,
): ReturnType<typeof createStripeClient> {
  const host = process.env['STRIPE_HOST'];
  const port = process.env['STRIPE_PORT'];
  return createStripeClient({
    secretKey,
    host,
    protocol: host === undefined ? undefined : 'http',
    port: port === undefined ? undefined : Number(port),
  });
}

/** Valideras vid start: en ogiltig bas skulle annars ge 500 på varje GET /events. Måste sluta på `/`, annars tappar `new URL` bas-pathen. */
function readAssetBaseUrl(): string {
  const value = process.env['PUBLIC_ASSET_BASE_URL'] ?? 'https://cdn.example.test/';
  if (!URL.canParse(value) || !value.endsWith('/')) {
    throw new Error('PUBLIC_ASSET_BASE_URL must be an absolute URL ending with "/"');
  }
  return value;
}

/** `API_CACHE_MAX_AGE_SECONDS` måste vara ett heltal >= 0; annars avvisar Redis `SET ... EX` varje skrivning tyst. */
function readCacheSeconds(): number {
  const value = Number(process.env['API_CACHE_MAX_AGE_SECONDS'] ?? 0);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('API_CACHE_MAX_AGE_SECONDS must be an integer >= 0');
  }
  return value;
}

function readTurnstileConfig(): ChallengeDeps['turnstile'] {
  const secret = process.env['TURNSTILE_SECRET_KEY'];
  if (secret === undefined || secret === '') {
    return undefined;
  }
  const hostname = process.env['TURNSTILE_EXPECTED_HOSTNAME'];
  return {
    secret,
    expectedHostname: hostname === undefined || hostname === '' ? undefined : hostname,
  };
}

export function loadDependencies(
  logger: Logger,
  businessMetrics: BusinessMetrics,
): Dependencies {
  const shardPools = createShardPools({
    onShardError: (shardIndex, error) => {
      logger.warn({ shardIndex, error }, 'shard connection error');
    },
  });
  const redis = createRedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const queueTokenSecret = createQueueTokenSecret(requireEnv('QUEUE_TOKEN_SECRET'));
  return {
    shardPools,
    logger,
    redis,
    queueTokenSecret,
    challenge: {
      shardPools,
      redis,
      logger,
      powKey: createPowKey(queueTokenSecret),
      turnstile: readTurnstileConfig(),
      bypassToken: process.env['CHALLENGE_BYPASS_TOKEN'],
    },
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
    // Tom som default — se routes/rate-limit.ts för varför och när den
    // sätts (bara under den faktiska lasttestkörningen, aldrig i vanlig drift).
    rateLimitAllowlistedIps: new Set(
      (process.env['RATE_LIMIT_ALLOWLISTED_IPS'] ?? '')
        .split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0),
    ),
    businessMetrics,
    publicAssetBaseUrl: readAssetBaseUrl(),
    apiCacheSeconds: readCacheSeconds(),
    analytics: createServerAnalyticsFromEnv(process.env, (error) => {
      logger.warn({ error }, 'posthog error');
    }),
  };
}
