import { describe, expect, it } from 'vitest';
import { createHttpMetrics, createRegistry } from '../metrics.js';

describe('createRegistry / createHttpMetrics', () => {
  it('registers default labels and RED metrics', async () => {
    const registry = createRegistry('test-service');
    const { requestsTotal, requestDuration } = createHttpMetrics(registry);

    requestsTotal.inc({ method: 'GET', route: '/health', status: '200' });
    requestDuration.observe({ method: 'GET', route: '/health', status: '200' }, 0.01);

    const output = await registry.metrics();
    expect(output).toContain('http_requests_total');
    expect(output).toContain('http_request_duration_seconds');
    expect(output).toContain('service="test-service"');
  });
});
