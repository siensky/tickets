import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../src/routes/health.js';

describe('health routes', () => {
  it('GET /health/live returns ok', async () => {
    const app = Fastify();
    registerHealthRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready returns ok', async () => {
    const app = Fastify();
    registerHealthRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
  });

  // rules.md §8: minst ett misslyckat fall per route. "Misslyckat" för
  // en parameterlös GET-endpoint betyder fel metod/väg, inte ett
  // domänfel — det finns ingen indata som kan vara ogiltig här.
  it('POST /health/live is not a registered route', async () => {
    const app = Fastify();
    registerHealthRoutes(app);

    const response = await app.inject({ method: 'POST', url: '/health/live' });
    expect(response.statusCode).toBe(404);
  });

  it('GET /health/does-not-exist is not a registered route', async () => {
    const app = Fastify();
    registerHealthRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/health/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });
});
