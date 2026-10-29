/**
 * Pact-providerverifiering för booking-api (docs/plan.md 7.9): spelar upp
 * kontrakten från `pacts/` (web och payment-mock) mot de RIKTIGA routerna,
 * controllerna, tjänsterna och repositoryna över en riktig Postgres och Redis.
 * Bara Auth0 (en fast tokenlista) och Stripe-anropet för att skapa en
 * Checkout-session är utbytta. Kör konsumenttesterna först (`pnpm test:contract`
 * i repo-roten gör det).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Verifier } from '@pact-foundation/pact';
import { createQueueTokenSecret, type Auth0Verifier } from '@tickets/auth';
import type { Logger } from '@tickets/observability';
import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { registerCheckoutRoutes } from '../../src/routes/checkout.js';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerEventRoutes } from '../../src/routes/events.js';
import { registerMyTicketsRoutes } from '../../src/routes/my-tickets.js';
import { registerOrderRoutes } from '../../src/routes/orders.js';
import { registerReservationRoutes } from '../../src/routes/reservations.js';
import { registerSeatmapRoutes } from '../../src/routes/seatmap.js';
import { registerWebhookRoutes } from '../../src/routes/webhooks.js';
import {
  SILENT_LOGGER,
  startTestDatabase,
  startTestRedis,
  stopTestDatabase,
  stopTestRedis,
  type TestDatabase,
  type TestRedis,
} from '../integration/test-helpers.js';
import { createStateHandlers, USER_SUB, type StateContext } from './provider-states.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const PACT_FILES = ['web-booking-api.json', 'payment-mock-booking-api.json'].map((name) =>
  resolve(PACTS_DIR, name),
);
const LOGGER = SILENT_LOGGER as unknown as Logger;
const WEBHOOK_SECRET = 'whsec_contract_provider';
const CONSUMER_TOKEN = 'contract-user';

// Auth0 ersätts av en fast tokenlista: kontraktet bryr sig om formen, inte om Auth0.
const verifier: Auth0Verifier = {
  verify: (token) =>
    Promise.resolve(
      token === CONSUMER_TOKEN
        ? { kind: 'valid', payload: { sub: USER_SUB, email: 'buyer@example.test' } }
        : { kind: 'invalid', reason: 'unknown contract token' },
    ),
};

interface FilterRequest {
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

// Kötoken är signerade med providerns hemlighet och bundna till eventet, så
// konsumentens platshållare byts mot det token statet utfärdade. Webhookens
// signatur räknas om över exakt de bytes som skickas (Stripe signerar rå body).
function createRequestFilter(
  context: StateContext,
  stripe: Stripe,
): (req: FilterRequest, res: unknown, next: () => void) => void {
  return (req, _res, next) => {
    if (
      req.headers['x-queue-token'] !== undefined &&
      context.currentQueueToken !== undefined
    ) {
      req.headers['x-queue-token'] = context.currentQueueToken;
    }
    if (req.headers['stripe-signature'] !== undefined) {
      // Proxyn JSON-parsar kroppen och vidarebefordrar JSON.stringify(body).
      req.headers['stripe-signature'] = stripe.webhooks.generateTestHeaderString({
        payload: Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : JSON.stringify(req.body),
        secret: WEBHOOK_SECRET,
      });
    }
    // Pact-proxyn skickar en tom, chunkad body för en POST utan body, och Fastify
    // svarar 415 på en body utan content-type. En riktig klient skickar ingen body alls.
    if (req.method === 'POST' && req.body === undefined) {
      req.headers['content-length'] = '0';
    }
    next();
  };
}

describe('booking-api provider verification', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: FastifyInstance;

  beforeAll(async () => {
    for (const file of PACT_FILES) {
      if (!existsSync(file)) {
        throw new Error(
          `${file} is missing. Run the consumer pact tests first (pnpm test:contract).`,
        );
      }
    }
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    app = Fastify();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  it('uppfyller kontrakten från web och payment-mock', async () => {
    const queueTokenSecret = createQueueTokenSecret(
      'contract-test-secret-at-least-32-bytes!!',
    );
    const stripe = new Stripe('sk_test_contract');
    stripe.checkout.sessions.create = (() =>
      Promise.resolve({
        id: 'cs_contract',
        url: 'https://checkout.test/cs_contract',
      })) as unknown as typeof stripe.checkout.sessions.create;
    const shardPools = db.shardPools;
    const queueDeps = { redis: redis.client, queueTokenSecret, logger: LOGGER };

    registerErrorHandler(app);
    registerEventRoutes(app, {
      shardPools,
      logger: LOGGER,
      assetBaseUrl: 'https://cdn.example.test/',
    });
    registerSeatmapRoutes(app, { shardPools, redis: redis.client, logger: LOGGER });
    registerReservationRoutes(app, { ...queueDeps, shardPools });
    registerCheckoutRoutes(
      app,
      {
        ...queueDeps,
        shardPools,
        stripe,
        paymentFrozenMinutes: 10,
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      },
      verifier,
    );
    registerMyTicketsRoutes(app, { shardPools, logger: LOGGER }, verifier);
    registerOrderRoutes(app, { shardPools }, verifier);
    registerWebhookRoutes(app, { shardPools, stripe, webhookSecret: WEBHOOK_SECRET });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const context: StateContext = {
      pool: db.shardPools.pools[0],
      redis: redis.client,
      queueTokenSecret,
      currentQueueToken: undefined,
    };

    await new Verifier({
      provider: 'booking-api',
      providerBaseUrl: `http://127.0.0.1:${String(port)}`,
      pactUrls: PACT_FILES,
      stateHandlers: createStateHandlers(context),
      // Kötoken är signerade med providerns hemlighet och bundna till eventet, så
      // konsumentens platshållare byts mot det token statet utfärdade. Webhookens
      // signatur räknas om över exakt de bytes som skickas (Stripe signerar rå body).
      requestFilter: createRequestFilter(context, stripe),
      logLevel: 'warn',
    }).verifyProvider();
  }, 120_000);
});
