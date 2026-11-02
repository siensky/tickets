/**
 * Redis-cachen för eventlistan (docs/plan.md 8.3): träff/miss, ingen cache utan TTL eller vid fritextsök,
 * och fail-open vid Redis-fel. Databasen ersätts av räknade repository-mockar; det som testas är cachelogiken.
 */
import type { ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEvents } = vi.hoisted(() => ({ listEvents: vi.fn() }));
vi.mock('../../src/repositories/events-repository.js', () => ({
  listEvents,
  getEventById: vi.fn(),
}));
vi.mock('../../src/repositories/venues-repository.js', () => ({
  getVenuesByIds: vi.fn(),
  getVenueById: vi.fn(),
}));

import { getVenuesByIds } from '../../src/repositories/venues-repository.js';
import { registerEventRoutes } from '../../src/routes/events.js';
import { listAllEvents, type EventsServiceDeps } from '../../src/services/events-service.js';

const LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const POOL_0 = { shard: 0 } as unknown as Pool;
const POOL_1 = { shard: 1 } as unknown as Pool;
const SHARD_POOLS = { pools: [POOL_0, POOL_1] } as unknown as ShardPools;

const EVENT_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  venueId: '22222222-2222-4222-8222-222222222222',
  title: 'Neon Rivers',
  artist: 'Neon Rivers',
  category: 'music',
  startsAt: new Date('2027-01-01T18:00:00Z'),
  salesOpenAt: new Date('2026-01-01T00:00:00Z'),
  salesCloseAt: new Date('2027-01-01T17:00:00Z'),
  status: 'scheduled',
  isBeforeOpen: false,
  isAfterClose: false,
  imageKey: 'images/neon.webp',
  description: null,
  featured: false,
  minPriceCents: 39_500,
  maxPriceCents: 69_500,
  availableSeats: 100,
  totalSeats: 500,
};

function fakeRedis(store = new Map<string, string>()): RedisClient {
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  } as unknown as RedisClient;
}

function deps(listCache?: EventsServiceDeps['listCache']): EventsServiceDeps {
  return {
    shardPools: SHARD_POOLS,
    logger: LOGGER,
    assetBaseUrl: 'https://cdn.example.test/',
    listCache,
  };
}

beforeEach(() => {
  listEvents.mockReset();
  // Ett event på shard 0, inget på shard 1.
  listEvents.mockImplementation((pool: Pool) =>
    Promise.resolve(pool === POOL_0 ? [EVENT_ROW] : []),
  );
  vi.mocked(getVenuesByIds).mockResolvedValue(
    new Map([
      [EVENT_ROW.venueId, { id: EVENT_ROW.venueId, name: 'Annexet', city: 'Stockholm' }],
    ]),
  );
});

describe('listAllEvents cache', () => {
  it('läser databasen en gång och sedan cachen inom TTL', async () => {
    const cache = { redis: fakeRedis(), ttlSeconds: 10 };

    await listAllEvents(deps(cache));
    await listAllEvents(deps(cache));

    expect(listEvents).toHaveBeenCalledTimes(2); // en gång per shard, bara första anropet
  });

  it('cachar varje kategori för sig', async () => {
    const cache = { redis: fakeRedis(), ttlSeconds: 10 };

    await listAllEvents(deps(cache), { category: 'music' });
    await listAllEvents(deps(cache), { category: 'sports' });

    expect(listEvents).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['ingen cache konfigurerad', undefined],
    ['TTL 0', { redis: fakeRedis(), ttlSeconds: 0 }],
  ])('cachar inte när %s', async (_label, cache) => {
    await listAllEvents(deps(cache));
    await listAllEvents(deps(cache));
    expect(listEvents).toHaveBeenCalledTimes(4);
  });

  it('cachar aldrig fritextsök (obegränsad nyckelmängd)', async () => {
    const set = vi.fn();
    const redis = { get: vi.fn().mockResolvedValue(null), set } as unknown as RedisClient;
    await listAllEvents(deps({ redis, ttlSeconds: 10 }), { search: 'coldplay' });
    await listAllEvents(deps({ redis, ttlSeconds: 10 }), { search: 'coldplay' });

    expect(listEvents).toHaveBeenCalledTimes(4);
    expect(set).not.toHaveBeenCalled();
  });

  it('faller tillbaka på databasen när Redis felar (fail-open)', async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as RedisClient;

    await expect(listAllEvents(deps({ redis, ttlSeconds: 10 }))).resolves.toHaveLength(1);
  });

  it('behandlar ett trasigt cachevärde som en miss', async () => {
    const store = new Map([['events:list:all', '{"inte":"en lista"}']]);
    await listAllEvents(deps({ redis: fakeRedis(store), ttlSeconds: 10 }));
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  it('ger samma icke-tomma data från cachen som från databasen (round-trip)', async () => {
    const uncached = await listAllEvents(deps());
    const cache = { redis: fakeRedis(), ttlSeconds: 10 };
    await listAllEvents(deps(cache)); // miss: fyller cachen
    listEvents.mockClear();

    const fromCache = await listAllEvents(deps(cache));

    expect(uncached).toHaveLength(1);
    expect(fromCache).toEqual(uncached);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('delar en databasfråga mellan samtidiga missar (single-flight)', async () => {
    const cache = { redis: fakeRedis(), ttlSeconds: 10 };

    await Promise.all([
      listAllEvents(deps(cache)),
      listAllEvents(deps(cache)),
      listAllEvents(deps(cache)),
    ]);

    expect(listEvents).toHaveBeenCalledTimes(2); // en gång per shard, inte tre gånger
  });

  it('cachar inte ett delresultat när en shard är nere', async () => {
    listEvents.mockImplementation((pool: Pool) =>
      pool === POOL_1 ? Promise.reject(new Error('shard down')) : Promise.resolve([EVENT_ROW]),
    );
    const store = new Map<string, string>();
    const cache = { redis: fakeRedis(store), ttlSeconds: 10 };

    const events = await listAllEvents(deps(cache));

    expect(events).toHaveLength(1);
    expect(store.size).toBe(0);
  });

  it('ger identiskt svar med och utan token (listan är inte personlig)', async () => {
    const app = Fastify();
    registerEventRoutes(app, deps());

    const anonymous = await app.inject({ method: 'GET', url: '/events' });
    const withToken = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { authorization: 'Bearer abc', 'x-queue-token': 'q' },
    });

    expect(anonymous.json<{ events: unknown[] }>().events).toHaveLength(1);
    expect(withToken.body).toBe(anonymous.body);
    await app.close();
  });
});
