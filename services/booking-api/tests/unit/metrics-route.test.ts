import { createRegistry } from '@tickets/observability';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerMetricsRoutes } from '../../src/routes/metrics.js';

describe('metrics route', () => {
  it('GET /metrics exposes Prometheus text format', async () => {
    const app = Fastify();
    const registry = createRegistry('booking-api-test');
    registerMetricsRoutes(app, registry);

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });
});
