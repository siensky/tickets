/**
 * "Välj evenemang" + arenakarta (sektionsvy) mot RIKTIGA Postgres- och
 * Redis-containrar (docs/rules.md §8). Events (sharded) och venues
 * (globala) ligger på olika "databaser" i produktion men delar samma
 * container här (test-helpers.ts) — testet bevisar fortfarande det
 * tvådelade frågemönstret (events-service.ts gör två separata frågor,
 * aldrig en join).
 */
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerEventRoutes } from '../../src/routes/events.js';
import { getEvent, listAllEvents } from '../../src/services/events-service.js';
import {
  getSectionGeometry,
  getSectionSeatStatusBody,
  listVenueSections,
} from '../../src/services/seatmap-service.js';
import {
  seedEventForVenue,
  seedSeatForSection,
  seedVenueSeat,
  seedVenueWithSection,
  SILENT_LOGGER,
  startTestDatabase,
  startTestRedis,
  stopTestDatabase,
  stopTestRedis,
  type TestDatabase,
  type TestRedis,
} from './test-helpers.js';

const LOGGER = SILENT_LOGGER as unknown as Logger;
const ASSET_BASE_URL = 'https://cdn.example.test/';

describe('events + seatmap', () => {
  let db: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  it('lists an event merged with its venue, and rejects an unknown event', async () => {
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const eventId = randomUUID();
    const pool = db.shardPools.pools[0];
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Test Arena',
      sectionId,
      sectionName: 'A',
    });
    await seedEventForVenue(pool, { eventId, venueId, title: 'Test Concert' });

    const events = await listAllEvents({
      shardPools: db.shardPools,
      logger: LOGGER,
      assetBaseUrl: ASSET_BASE_URL,
    });
    expect(events.map((event) => event.id)).toContain(eventId);
    const found = events.find((event) => event.id === eventId);
    expect(found).toMatchObject({ title: 'Test Concert', venueName: 'Test Arena' });

    const detail = await getEvent(
      { shardPools: db.shardPools, logger: LOGGER, assetBaseUrl: ASSET_BASE_URL },
      eventId,
    );
    expect(detail).toMatchObject({ id: eventId, venueCity: 'Test City' });

    await expect(
      getEvent(
        { shardPools: db.shardPools, logger: LOGGER, assetBaseUrl: ASSET_BASE_URL },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  }, 60_000);

  it('filters the listing by category and by a free-text search term (Fas 6)', async () => {
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const musicEventId = randomUUID();
    const sportsEventId = randomUUID();
    const pool = db.shardPools.pools[0];
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Filter Arena',
      sectionId,
      sectionName: 'A',
    });
    await seedEventForVenue(pool, {
      eventId: musicEventId,
      venueId,
      title: 'Coldplay Live',
      artist: 'Coldplay',
      category: 'music',
    });
    await seedEventForVenue(pool, {
      eventId: sportsEventId,
      venueId,
      title: 'Cup Final',
      artist: 'Home Team',
      category: 'sports',
    });

    const deps = { shardPools: db.shardPools, logger: LOGGER, assetBaseUrl: ASSET_BASE_URL };
    const musicOnly = await listAllEvents(deps, { category: 'music' });
    expect(musicOnly.map((event) => event.id)).toContain(musicEventId);
    expect(musicOnly.map((event) => event.id)).not.toContain(sportsEventId);

    const searchResults = await listAllEvents(deps, { search: 'coldplay' });
    expect(searchResults.map((event) => event.id)).toContain(musicEventId);
    expect(searchResults.map((event) => event.id)).not.toContain(sportsEventId);
  }, 60_000);

  it('GET /events: 200 for a valid category query param, 400 for an unknown one (docs/rules.md §8)', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    registerEventRoutes(app, {
      shardPools: db.shardPools,
      logger: LOGGER,
      assetBaseUrl: ASSET_BASE_URL,
    });

    const ok = await app.inject({ method: 'GET', url: '/events?category=music' });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({ method: 'GET', url: '/events?category=cooking' });
    expect(bad.statusCode).toBe(400);
  }, 30_000);

  it('lists a venue section and its seat geometry, and rejects a section from another venue', async () => {
    const venueId = randomUUID();
    const otherVenueId = randomUUID();
    const sectionId = randomUUID();
    const venueSeatId = randomUUID();
    const pool = db.shardPools.pools[0];
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Geometry Arena',
      sectionId,
      sectionName: 'Floor',
    });
    await pool.query(
      `INSERT INTO venues (id, name, city) VALUES ($1, 'Other Arena', 'Elsewhere')`,
      [otherVenueId],
    );
    await seedVenueSeat(pool, {
      venueSeatId,
      venueId,
      sectionId,
      row: 'A',
      number: 1,
      x: 1.5,
      y: 2.5,
    });

    const sections = await listVenueSections(
      { shardPools: db.shardPools, redis: redis.client, logger: LOGGER },
      venueId,
    );
    expect(sections.map((section) => section.id)).toContain(sectionId);

    const seats = await getSectionGeometry(
      { shardPools: db.shardPools, redis: redis.client, logger: LOGGER },
      venueId,
      sectionId,
    );
    expect(seats).toEqual([{ id: venueSeatId, row: 'A', number: 1, x: 1.5, y: 2.5 }]);

    await expect(
      getSectionGeometry(
        { shardPools: db.shardPools, redis: redis.client, logger: LOGGER },
        otherVenueId,
        sectionId,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  }, 60_000);

  it('reads seat status from Postgres on a cache miss, then from Redis on the next call', async () => {
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const eventId = randomUUID();
    const venueSeatId = randomUUID();
    const seatId = randomUUID();
    const pool = db.shardPools.pools[0];
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Status Arena',
      sectionId,
      sectionName: 'B',
    });
    await seedEventForVenue(pool, { eventId, venueId });
    await seedSeatForSection(pool, {
      seatId,
      eventId,
      venueSeatId,
      sectionId,
      row: 'A',
      number: 1,
      ticketNumber: `TICKET-${eventId}`,
      status: 'held',
    });

    const deps = { shardPools: db.shardPools, redis: redis.client, logger: LOGGER };
    const firstRead: unknown = JSON.parse(
      await getSectionSeatStatusBody(deps, eventId, sectionId),
    );
    expect(firstRead).toEqual({
      seats: [{ seatId, venueSeatId, status: 'held', priceCents: 1000, heldUntil: null }],
    });

    // Flip the row directly — if the second read still returns 'held',
    // it proves the value came from the Redis cache, not a fresh query.
    await pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seatId]);
    const secondRead: unknown = JSON.parse(
      await getSectionSeatStatusBody(deps, eventId, sectionId),
    );
    expect(secondRead).toEqual({
      seats: [{ seatId, venueSeatId, status: 'held', priceCents: 1000, heldUntil: null }],
    });
  }, 60_000);

  it('catalog + compact describe exactly the same seats as the full view, in the same order', async () => {
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const eventId = randomUUID();
    const pool = db.shardPools.pools[0];
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Vy Arena',
      sectionId,
      sectionName: 'C',
    });
    await seedEventForVenue(pool, { eventId, venueId });
    const statuses = ['available', 'held', 'sold', 'available'] as const;
    for (const [index, status] of statuses.entries()) {
      await seedSeatForSection(pool, {
        seatId: randomUUID(),
        eventId,
        venueSeatId: randomUUID(),
        sectionId,
        row: 'A',
        number: index + 1,
        ticketNumber: `TICKET-${eventId}-${String(index)}`,
        status,
      });
    }
    const deps = { shardPools: db.shardPools, redis: redis.client, logger: LOGGER };
    const read = async (view: 'full' | 'catalog' | 'compact'): Promise<unknown> =>
      JSON.parse(await getSectionSeatStatusBody(deps, eventId, sectionId, view));

    const full = fullSeatsSchema.parse(await read('full'));
    const catalog = catalogSchema.parse(await read('catalog'));
    const compact = compactSchema.parse(await read('compact'));

    const STATUS_BY_CHAR = { a: 'available', h: 'held', s: 'sold' } as const;
    expect(catalog.version).toBe(compact.version);
    expect(compact.statuses).toHaveLength(full.seats.length);
    const rebuilt = catalog.seats.map((seat, index) => ({
      ...seat,
      status: STATUS_BY_CHAR[compactCharAt(compact.statuses, index)],
      heldUntil: null,
    }));
    expect(rebuilt).toEqual(full.seats);
  }, 60_000);
});

const fullSeatsSchema = z.object({
  seats: z.array(
    z.object({
      seatId: z.string(),
      venueSeatId: z.string(),
      status: z.enum(['available', 'held', 'sold']),
      priceCents: z.number(),
      heldUntil: z.null(),
    }),
  ),
});
const catalogSchema = z.object({
  version: z.string(),
  seats: z.array(
    z.object({ seatId: z.string(), venueSeatId: z.string(), priceCents: z.number() }),
  ),
});
const compactSchema = z.object({
  version: z.string(),
  statuses: z.string(),
  heldUntil: z.array(z.object({ index: z.number(), until: z.string() })),
});

function compactCharAt(statuses: string, index: number): 'a' | 'h' | 's' {
  const char = statuses.charAt(index);
  if (char !== 'a' && char !== 'h' && char !== 's') {
    throw new Error(`unexpected status character ${char}`);
  }
  return char;
}
