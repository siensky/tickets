/**
 * Botskyddet på `POST /events/:eventId/queue/join` mot riktiga Postgres och Redis (docs/plan.md 8.5): alla
 * tre nivåerna, engångslösningar, kill switch, lasttestets bypass och att ett 428 aldrig räknas som en join.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createQueueTokenSecret } from '@tickets/auth';
import { createBusinessMetrics, createRegistry, type Logger } from '@tickets/observability';
import { configCacheKey } from '@tickets/redis';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerQueueRoutes } from '../../src/routes/queue.js';
import type { ChallengeDeps } from '../../src/services/challenge-service.js';
import { createPowKey, leadingZeroBits } from '../../src/services/pow.js';
import {
  seedEventWithSeats,
  SILENT_LOGGER,
  startTestDatabase,
  startTestRedis,
  stopTestDatabase,
  stopTestRedis,
  type TestDatabase,
  type TestRedis,
} from './test-helpers.js';

const SECRET = createQueueTokenSecret('integration-test-secret-at-least-32-bytes!!');
const LOGGER = SILENT_LOGGER as unknown as Logger;
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const BYPASS = 'bypass-token-for-tests-0123456789abcdef';

interface Challenge {
  type: 'pow' | 'turnstile';
  challenge?: string;
}

function solve(challenge: string, bits: number): string {
  for (let candidate = 0; ; candidate += 1) {
    const digest = createHash('sha256').update(`${challenge}:${candidate}`).digest();
    if (leadingZeroBits(digest) >= bits) {
      return String(candidate);
    }
  }
}

describe('queue/join botskydd', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  let app: FastifyInstance;
  let eventId: string;
  let turnstileOk = true;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    app = Fastify({ trustProxy: true });
    registerErrorHandler(app);
    const challenge: ChallengeDeps = {
      shardPools: db.shardPools,
      redis: redis.client,
      logger: LOGGER,
      powKey: createPowKey(SECRET),
      turnstile: { secret: 'test-secret', expectedHostname: undefined },
      bypassToken: BYPASS,
      fetchFn: () =>
        Promise.resolve(
          Response.json({
            success: turnstileOk,
            action: 'queue_join',
            hostname: 'tikknet.se',
          }),
        ),
    };
    registerQueueRoutes(app, {
      shardPools: db.shardPools,
      redis: redis.client,
      queueTokenSecret: SECRET,
      logger: LOGGER,
      businessMetrics: createBusinessMetrics(createRegistry('test')),
      challenge,
    });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  beforeEach(async () => {
    await redis.client.flushall();
    // Standardvärdena från migrationen, så att ett tests tröskelvärden inte läcker till nästa.
    await db.shardPools.pools[0].query(`DELETE FROM config WHERE key LIKE 'challenge\\_%'`);
    await db.shardPools.pools[0].query(
      `INSERT INTO config (key, value) VALUES ('challenge_enabled','1'), ('challenge_ip_attempts_per_minute','10'),
       ('challenge_ip_joins_per_window','5'), ('challenge_global_queue_depth','0'), ('challenge_pow_bits','16')`,
    );
    turnstileOk = true;
    eventId = randomUUID();
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds: [randomUUID()] });
  });

  async function setConfig(key: string, value: string): Promise<void> {
    await db.shardPools.pools[0].query(
      `INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
    await redis.client.del(configCacheKey('challenge_bundle'));
  }

  function join(headers: Record<string, string> = {}, ip = '10.0.0.1') {
    return app.inject({
      method: 'POST',
      url: `/events/${eventId}/queue/join`,
      remoteAddress: ip,
      headers: { 'user-agent': BROWSER_UA, 'x-forwarded-for': ip, ...headers },
    });
  }

  function challengeOf(body: string): Challenge & { bits: number } {
    const parsed = JSON.parse(body) as {
      error: { context: { challenge: Challenge & { bits: number } } };
    };
    return parsed.error.context.challenge;
  }

  it('nivå 0: en vanlig webbläsare får ett kötoken utan utmaning', async () => {
    expect((await join()).statusCode).toBe(201);
  });

  it('nivå 1: en uppenbar automat-User-Agent får en PoW-utmaning, som kan lösas en gång', async () => {
    const first = await join({ 'user-agent': 'curl/8.4.0' });
    expect(first.statusCode).toBe(428);
    const required = challengeOf(first.body);
    expect(required.type).toBe('pow');
    const solution = solve(required.challenge ?? '', required.bits);
    const proof = {
      'user-agent': 'curl/8.4.0',
      'x-pow-challenge': required.challenge ?? '',
      'x-pow-solution': solution,
    };

    expect((await join(proof)).statusCode).toBe(201);
    // Samma lösning en gång till: förbrukad, nytt 428.
    expect((await join(proof)).statusCode).toBe(428);
  }, 60_000);

  it('en lösning gäller bara för IP:n den utfärdades åt', async () => {
    const first = await join({ 'user-agent': 'curl/8.4.0' }, '10.0.0.7');
    const required = challengeOf(first.body);

    const stolen = await join(
      {
        'user-agent': 'curl/8.4.0',
        'x-pow-challenge': required.challenge ?? '',
        'x-pow-solution': solve(required.challenge ?? '', required.bits),
      },
      '10.0.0.8',
    );

    expect(stolen.statusCode).toBe(428);
  }, 60_000);

  it('nivå 2: två signaler kräver Turnstile, som verifieras mot siteverify', async () => {
    await setConfig('challenge_ip_attempts_per_minute', '1');
    await join({ 'user-agent': 'curl/8.4.0' });
    const second = await join({ 'user-agent': 'curl/8.4.0' });
    expect(second.statusCode).toBe(428);
    expect(challengeOf(second.body).type).toBe('turnstile');

    turnstileOk = false;
    const rejected = await join({ 'user-agent': 'curl/8.4.0', 'x-turnstile-token': 'bad' });
    expect(rejected.statusCode).toBe(428);

    turnstileOk = true;
    const accepted = await join({ 'user-agent': 'curl/8.4.0', 'x-turnstile-token': 'good' });
    expect(accepted.statusCode).toBe(201);
  }, 60_000);

  it('för många join från samma IP och event utlöser en utmaning, ett 428 räknas aldrig som join', async () => {
    await setConfig('challenge_ip_joins_per_window', '2');
    for (let i = 0; i < 2; i += 1) {
      expect((await join()).statusCode).toBe(201);
    }
    expect((await join()).statusCode).toBe(428);
    // Flera 428-svar i rad ökar inte join-räknaren, och IP-volymen är EN signal: fortfarande PoW, inte Turnstile.
    expect(challengeOf((await join()).body).type).toBe('pow');
  }, 60_000);

  it('en salva parallella join släpps inte igenom som nivå 0 (reservationen är atomisk)', async () => {
    await setConfig('challenge_ip_joins_per_window', '2');

    const responses = await Promise.all(Array.from({ length: 10 }, () => join()));

    const accepted = responses.filter((response) => response.statusCode === 201).length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(10);
  }, 60_000);

  it('en påhittad bevis-header stänger inte av försökssignalen', async () => {
    await setConfig('challenge_ip_attempts_per_minute', '1');
    expect((await join()).statusCode).toBe(201);

    const second = await join({ 'x-turnstile-token': 'påhittad' });

    expect(second.statusCode).toBe(428);
  }, 60_000);

  it('kill switchen stänger av alla nivåer', async () => {
    await setConfig('challenge_enabled', '0');
    expect((await join({ 'user-agent': 'curl/8.4.0' })).statusCode).toBe(201);
  });

  it('lasttestets bypass-header släpper igenom, ett fel värde gör det inte', async () => {
    expect(
      (await join({ 'user-agent': 'k6/0.50', 'x-challenge-bypass': BYPASS })).statusCode,
    ).toBe(201);
    expect(
      (await join({ 'user-agent': 'curl/8.4.0', 'x-challenge-bypass': 'wrong' })).statusCode,
    ).toBe(428);
  });
});
