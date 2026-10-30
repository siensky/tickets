/**
 * Fas 7 steg 5 (docs/plan.md 7.13 E1, E2, E5, E6) mot RIKTIGA Postgres- och
 * Redis-containrar (docs/rules.md §8): eventets presentationsfält och
 * tillgänglighet, sektionssammanfattningen, reservationsvyn med serverns
 * summa och orderstatusen (med IDOR-skydd).
 */
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@tickets/domain';
import type { Auth0Verifier } from '@tickets/auth';
import type { Logger } from '@tickets/observability';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerOrderRoutes } from '../../src/routes/orders.js';
import { registerSeatmapRoutes } from '../../src/routes/seatmap.js';
import { getEvent, listAllEvents } from '../../src/services/events-service.js';
import {
  getReservationForQueueToken,
  reserveSeats,
} from '../../src/services/reservation-service.js';
import {
  seedEventForVenue,
  seedOrderWithTicket,
  seedSeatForSection,
  seedUser,
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

async function seedSeats(
  pool: Pool,
  params: {
    eventId: string;
    sectionId: string;
    row: string;
    count: number;
    priceCents: number;
  },
): Promise<string[]> {
  const ids: string[] = [];
  for (let number = 1; number <= params.count; number++) {
    const seatId = randomUUID();
    ids.push(seatId);
    await seedSeatForSection(pool, {
      seatId,
      eventId: params.eventId,
      venueSeatId: randomUUID(),
      sectionId: params.sectionId,
      row: params.row,
      number,
      ticketNumber: `T-${seatId}`,
    });
    await pool.query('UPDATE seats SET price_cents = $2 WHERE id = $1', [
      seatId,
      params.priceCents,
    ]);
  }
  return ids;
}

describe('presentation endpoints (Fas 7 steg 5)', () => {
  let db: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  it('E1: eventet bär bild, beskrivning, prisintervall och tillgänglighet; imageUrl är null när kolumnen är NULL', async () => {
    const pool = db.shardPools.pools[0];
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const withImage = randomUUID();
    const withoutImage = randomUUID();
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'E1 Arena',
      sectionId,
      sectionName: 'Parkett',
    });
    await seedEventForVenue(pool, { eventId: withImage, venueId });
    await seedEventForVenue(pool, { eventId: withoutImage, venueId });
    await pool.query(
      `UPDATE events SET image_url = 'images/neon-rivers.webp', description = 'Beskrivning',
              featured = true WHERE id = $1`,
      [withImage],
    );
    await seedSeats(pool, {
      eventId: withImage,
      sectionId,
      row: 'A',
      count: 20,
      priceCents: 39500,
    });
    const [expensive] = await seedSeats(pool, {
      eventId: withImage,
      sectionId,
      row: 'B',
      count: 1,
      priceCents: 69500,
    });
    await pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [expensive]);

    const deps = { shardPools: db.shardPools, logger: LOGGER, assetBaseUrl: ASSET_BASE_URL };
    const detail = await getEvent(deps, withImage);
    expect(detail).toMatchObject({
      imageUrl: 'https://cdn.example.test/images/neon-rivers.webp',
      description: 'Beskrivning',
      featured: true,
      minPriceCents: 39500,
      maxPriceCents: 69500,
      availableSeats: 20,
      totalSeats: 21,
      availability: 'on_sale',
    });

    const listed = (await listAllEvents(deps)).find((event) => event.id === withoutImage);
    expect(listed).toMatchObject({
      imageUrl: null,
      description: null,
      featured: false,
      minPriceCents: null,
      maxPriceCents: null,
      availableSeats: 0,
      totalSeats: 0,
      availability: 'sold_out',
    });
  }, 60_000);

  describe('E2: GET /events/:eventId/sections/summary', () => {
    it('slår ihop layout och aggregat, utelämnar sektioner utan stolar och ger layout null utan layout', async () => {
      const pool = db.shardPools.pools[0];
      const venueId = randomUUID();
      const floorId = randomUUID();
      const emptyId = randomUUID();
      const eventId = randomUUID();
      await seedVenueWithSection(pool, {
        venueId,
        venueName: 'E2 Arena',
        sectionId: floorId,
        sectionName: 'Golv',
      });
      await pool.query(
        `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, 'Tom', 2)`,
        [emptyId, venueId],
      );
      await pool.query(
        `UPDATE venue_sections SET layout_x = 100, layout_y = 200, layout_width = 300,
                layout_height = 150, layout_rotation = 5 WHERE id = $1`,
        [floorId],
      );
      await pool.query(
        `UPDATE venues SET stage_x = 350, stage_y = 20, stage_width = 300, stage_height = 60
         WHERE id = $1`,
        [venueId],
      );
      await seedEventForVenue(pool, { eventId, venueId });
      const seatIds = await seedSeats(pool, {
        eventId,
        sectionId: floorId,
        row: 'A',
        count: 3,
        priceCents: 50000,
      });
      await pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seatIds[0]]);

      const app = Fastify();
      registerErrorHandler(app);
      registerSeatmapRoutes(app, {
        shardPools: db.shardPools,
        redis: redis.client,
        logger: LOGGER,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/events/${eventId}/sections/summary`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        stage: { x: 350, y: 20, width: 300, height: 60 },
        sections: [
          {
            id: floorId,
            name: 'Golv',
            displayOrder: 1,
            layout: { x: 100, y: 200, width: 300, height: 150, rotation: 5 },
            availableCount: 2,
            totalCount: 3,
            minPriceCents: 50000,
            maxPriceCents: 50000,
            availability: 'few_left',
          },
        ],
      });

      await pool.query('UPDATE venue_sections SET layout_x = NULL WHERE id = $1', [floorId]);
      const noLayout = await app.inject({
        method: 'GET',
        url: `/events/${eventId}/sections/summary`,
      });
      expect(
        noLayout.json<{ sections: { layout: unknown }[] }>().sections[0]?.layout,
      ).toBeNull();
    }, 60_000);

    it('ger 404 för ett okänt event och 400 för ett ogiltigt id', async () => {
      const app = Fastify();
      registerErrorHandler(app);
      registerSeatmapRoutes(app, {
        shardPools: db.shardPools,
        redis: redis.client,
        logger: LOGGER,
      });

      const unknown = await app.inject({
        method: 'GET',
        url: `/events/${randomUUID()}/sections/summary`,
      });
      expect(unknown.statusCode).toBe(404);
      const invalid = await app.inject({
        method: 'GET',
        url: '/events/nope/sections/summary',
      });
      expect(invalid.statusCode).toBe(400);
    }, 30_000);
  });

  describe('E5: reservationsvyn', () => {
    it('listar stolarna sorterade på sektion, rad och plats, med summan av serverns priser', async () => {
      const pool = db.shardPools.pools[0];
      const venueId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const eventId = randomUUID();
      await seedVenueWithSection(pool, {
        venueId,
        venueName: 'E5 Arena',
        sectionId: firstId,
        sectionName: 'Parkett',
      });
      await pool.query(
        `INSERT INTO venue_sections (id, venue_id, name, display_order) VALUES ($1, $2, 'Läktare', 2)`,
        [secondId, venueId],
      );
      await seedEventForVenue(pool, { eventId, venueId });
      const [parkett] = await seedSeats(pool, {
        eventId,
        sectionId: firstId,
        row: 'A',
        count: 1,
        priceCents: 69500,
      });
      const lakt = await seedSeats(pool, {
        eventId,
        sectionId: secondId,
        row: 'B',
        count: 2,
        priceCents: 39500,
      });
      const queueTokenId = randomUUID();
      const reserved = await reserveSeats(db.shardPools, {
        eventId,
        seatIds: [lakt[1] ?? '', parkett ?? '', lakt[0] ?? ''],
        queueTokenId,
        idempotencyKey: randomUUID(),
      });

      const view = await getReservationForQueueToken(
        db.shardPools,
        eventId,
        reserved.reservationId,
        queueTokenId,
      );

      expect(view.totalCents).toBe(69500 + 2 * 39500);
      expect(view.currency).toBe('SEK');
      expect(view.seats.map((seat) => [seat.sectionName, seat.row, seat.number])).toEqual([
        ['Parkett', 'A', 1],
        ['Läktare', 'B', 1],
        ['Läktare', 'B', 2],
      ]);
      expect(view.seatIds).toHaveLength(3);
    }, 60_000);

    it('ger NotFoundError för en annan kötoken', async () => {
      const pool = db.shardPools.pools[0];
      const eventId = randomUUID();
      const seatId = randomUUID();
      await seedBareEvent(pool, eventId);
      await seedSeatForSection(pool, {
        seatId,
        eventId,
        venueSeatId: randomUUID(),
        sectionId: randomUUID(),
        row: 'A',
        number: 1,
        ticketNumber: `T-${seatId}`,
      });
      const reserved = await reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatId],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      });

      await expect(
        getReservationForQueueToken(
          db.shardPools,
          eventId,
          reserved.reservationId,
          randomUUID(),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    }, 60_000);
  });

  describe('E6: GET /events/:eventId/orders/:orderId', () => {
    const verifier: Auth0Verifier = {
      verify: (token) =>
        Promise.resolve(
          token === 'invalid'
            ? { kind: 'invalid', reason: 'bad token' }
            : { kind: 'valid', payload: { sub: token, email: `${token}@example.test` } },
        ),
    };

    async function seedPaidOrder(
      pool: Pool,
    ): Promise<{ eventId: string; orderId: string; sub: string }> {
      const userId = randomUUID();
      const sub = `auth0|${userId}`;
      const eventId = randomUUID();
      const venueId = randomUUID();
      const sectionId = randomUUID();
      const seatId = randomUUID();
      const orderId = randomUUID();
      await seedUser(pool, { userId, auth0Sub: sub, email: `${userId}@example.test` });
      await seedVenueWithSection(pool, {
        venueId,
        venueName: 'E6',
        sectionId,
        sectionName: 'A',
      });
      await seedEventForVenue(pool, { eventId, venueId });
      await seedSeatForSection(pool, {
        seatId,
        eventId,
        venueSeatId: randomUUID(),
        sectionId,
        row: 'A',
        number: 1,
        ticketNumber: `T-${seatId}`,
        status: 'sold',
      });
      await seedOrderWithTicket(pool, {
        orderId,
        eventId,
        userId,
        seatId,
        ticketId: randomUUID(),
        qrToken: `qr-${orderId}`,
      });
      return { eventId, orderId, sub };
    }

    function buildApp(): FastifyInstance {
      const app = Fastify();
      registerErrorHandler(app);
      registerOrderRoutes(app, { shardPools: db.shardPools }, verifier);
      return app;
    }

    it('ger 200 med status och antal biljetter för den egna ordern', async () => {
      const { eventId, orderId, sub } = await seedPaidOrder(db.shardPools.pools[0]);

      const response = await buildApp().inject({
        method: 'GET',
        url: `/events/${eventId}/orders/${orderId}`,
        headers: { authorization: `Bearer ${sub}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        orderId,
        eventId,
        status: 'paid',
        totalCents: 1000,
        ticketCount: 1,
      });
    }, 60_000);

    it('ger 404 för en annans order och för okänd användare, 401 utan giltig token', async () => {
      const { eventId, orderId } = await seedPaidOrder(db.shardPools.pools[0]);
      const other = await seedPaidOrder(db.shardPools.pools[0]);
      const app = buildApp();
      const url = `/events/${eventId}/orders/${orderId}`;

      const foreign = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${other.sub}` },
      });
      expect(foreign.statusCode).toBe(404);
      const unknownUser = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer auth0|nobody' },
      });
      expect(unknownUser.statusCode).toBe(404);
      const noToken = await app.inject({ method: 'GET', url });
      expect(noToken.statusCode).toBe(401);
      const badToken = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer invalid' },
      });
      expect(badToken.statusCode).toBe(401);
    }, 60_000);
  });
});

async function seedBareEvent(pool: Pool, eventId: string): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Bare', 'Bare', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days')`,
    [eventId],
  );
}
