import { createLogger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerRateLimitHook } from '../../src/routes/rate-limit.js';

const logger = createLogger({ serviceName: 'test' });

function fakeRedis(): RedisClient {
  let count = 0;
  return {
    eval: vi.fn().mockImplementation(() => {
      count += 1;
      return Promise.resolve(count);
    }),
  } as unknown as RedisClient;
}

describe('registerRateLimitHook', () => {
  it('rejects a request over the limit from a non-allowlisted ip', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/events', () => ({ ok: true }));
    registerRateLimitHook(app, fakeRedis(), 0, logger);

    const response = await app.inject({ method: 'GET', url: '/events' });

    expect(response.statusCode).toBe(429);
  });

  it('skips the limit entirely for an allowlisted ip (docs/plan.md "Lasttest")', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/events', () => ({ ok: true }));
    registerRateLimitHook(app, fakeRedis(), 0, logger, new Set(['127.0.0.1']));

    const response = await app.inject({ method: 'GET', url: '/events' });

    expect(response.statusCode).toBe(200);
  });
});
