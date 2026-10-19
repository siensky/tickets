import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../src/routes/health.js';

describe('health routes', () => {
  it('GET /health/live returns ok', async () => {
    const app = Fastify();
    registerHealthRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
  });
});
