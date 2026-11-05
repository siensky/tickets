/**
 * Cache-headers på de publika seatmap-routes (docs/plan.md 8.3): sammanfattningen får `max-age` bara när
 * API-cachen är på, och alla edge-cachade svar bär `Access-Control-Allow-Origin: *` så att ett cachat svar
 * aldrig kan sakna CORS-header. Svaret ska aldrig bero på inloggning eller kötoken.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { SeatmapServiceDeps } from '../../src/services/seatmap-service.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/seatmap-service.js', () => ({
  getSectionSummaryBody: vi.fn().mockResolvedValue('{"stage":null,"sections":[]}'),
  getSectionSeatStatusBody: vi.fn().mockResolvedValue('{"seats":[]}'),
  getSectionGeometry: vi.fn().mockResolvedValue([]),
  listVenueSections: vi.fn().mockResolvedValue([]),
}));

import { registerSeatmapRoutes } from '../../src/routes/seatmap.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SECTION_ID = '33333333-3333-4333-8333-333333333333';
// Servicen är mockad ovan, så beroendena används aldrig.
const DEPS = { shardPools: {}, redis: {}, logger: {} } as unknown as SeatmapServiceDeps;

function appWith(summaryCacheSeconds: number): FastifyInstance {
  const app = Fastify();
  registerSeatmapRoutes(app, { ...DEPS, summaryCacheSeconds });
  return app;
}

describe('seatmap cache headers', () => {
  it('sätter max-age och ACAO * på sammanfattningen när cachen är på, oberoende av token', async () => {
    const app = appWith(5);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/events/${EVENT_ID}/sections/summary`,
    });
    const withToken = await app.inject({
      method: 'GET',
      url: `/events/${EVENT_ID}/sections/summary`,
      headers: { authorization: 'Bearer abc', 'x-queue-token': 'q' },
    });

    expect(anonymous.headers['cache-control']).toBe('public, max-age=5');
    expect(anonymous.headers['access-control-allow-origin']).toBe('*');
    expect(withToken.headers['cache-control']).toBe(anonymous.headers['cache-control']);
    expect(withToken.body).toBe(anonymous.body);
    await app.close();
  });

  it('sätter ingen cache-header på sammanfattningen när cachen är av (kill switch)', async () => {
    const app = appWith(0);

    const response = await app.inject({
      method: 'GET',
      url: `/events/${EVENT_ID}/sections/summary`,
    });

    expect(response.headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('ger stolsstatus ACAO * så att ett cachat svar aldrig saknar CORS-header', async () => {
    const app = appWith(0);

    const response = await app.inject({
      method: 'GET',
      url: `/events/${EVENT_ID}/sections/${SECTION_ID}/seats/status`,
    });

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=1');
    // Det färdiga svaret skickas som det är, men fortfarande som JSON.
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.json()).toEqual({ seats: [] });
    await app.close();
  });
});
