import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerCors } from '../../src/routes/cors.js';

describe('CORS', () => {
  it('allows a configured origin and the custom headers the app sends', async () => {
    process.env['CORS_ALLOWED_ORIGINS'] = 'https://tikknet.se';
    const app = Fastify();
    registerCors(app);
    app.get('/health/live', () => ({ status: 'ok' }));

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: {
        origin: 'https://tikknet.se',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-queue-token,idempotency-key,authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://tikknet.se');
    delete process.env['CORS_ALLOWED_ORIGINS'];
  });

  it('rejects an origin that is not in the allowlist', async () => {
    process.env['CORS_ALLOWED_ORIGINS'] = 'https://tikknet.se';
    const app = Fastify();
    registerCors(app);
    app.get('/health/live', () => ({ status: 'ok' }));

    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    delete process.env['CORS_ALLOWED_ORIGINS'];
  });
});
