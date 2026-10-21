import { createRegistry } from '@tickets/observability';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerMetricsRoutes } from '../../src/routes/metrics.js';

describe('metrics route', () => {
  it('GET /metrics exposes Prometheus text format', async () => {
    const app = Fastify();
    const registry = createRegistry('realtime-gateway-test');
    registerMetricsRoutes(app, registry);

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  // rules.md §8: minst ett misslyckat fall per route.
  it('POST /metrics is not a registered route', async () => {
    const app = Fastify();
    const registry = createRegistry('realtime-gateway-test-post');
    registerMetricsRoutes(app, registry);

    const response = await app.inject({ method: 'POST', url: '/metrics' });
    expect(response.statusCode).toBe(404);
  });
});
