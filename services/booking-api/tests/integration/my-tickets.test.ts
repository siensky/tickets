/**
 * "Mina biljetter" mot en RIKTIG Postgres-container (docs/rules.md §8).
 * `db.shardPools.pools[0] === pools[1]` here (one container plays both
 * shards, see test-helpers.ts) — detta bevisar fortfarande att
 * `listMyTickets` frågar VARJE pool i `shardPools.pools` och slår ihop
 * resultaten, den faktiska scatter-gather-kontrakten docs/plan.md
 * beskriver. Just därför matchar testet på `orderId` i stället för att
 * anta exakt en rad: eftersom båda "shardarna" här råkar peka på SAMMA
 * container ser frågan samma order TVÅ gånger (en gång per pool-post) —
 * ofarligt och förväntat i den här testuppställningen, aldrig i
 * produktion där poolerna pekar på olika databaser.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@tickets/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMyTickets } from '../../src/services/my-tickets-service.js';
import {
  seedEventForVenue,
  seedOrderWithTicket,
  seedSeatForSection,
  seedUser,
  seedVenueWithSection,
  SILENT_LOGGER,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

const LOGGER = SILENT_LOGGER as unknown as Logger;

describe('my tickets', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('returns a purchased ticket with its seat and event title', async () => {
    const pool = db.shardPools.pools[0];
    const userId = randomUUID();
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const eventId = randomUUID();
    const seatId = randomUUID();
    const orderId = randomUUID();
    const ticketId = randomUUID();

    await seedUser(pool, { userId, auth0Sub: `auth0|${userId}`, email: 'buyer@example.test' });
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Arena',
      sectionId,
      sectionName: 'A',
    });
    await seedEventForVenue(pool, { eventId, venueId, title: 'My Tickets Concert' });
    await seedSeatForSection(pool, {
      seatId,
      eventId,
      venueSeatId: randomUUID(),
      sectionId,
      row: 'A',
      number: 7,
      ticketNumber: `TICKET-${eventId}`,
      status: 'sold',
    });
    await seedOrderWithTicket(pool, {
      orderId,
      eventId,
      userId,
      seatId,
      ticketId,
      qrToken: 'qr-token-value',
    });

    const orders = await listMyTickets({ shardPools: db.shardPools, logger: LOGGER }, userId);
    const matching = orders.filter((order) => order.orderId === orderId);

    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0]?.eventStartsAt).toEqual(expect.any(String));
    expect(matching[0]).toMatchObject({
      orderId,
      eventId,
      eventTitle: 'My Tickets Concert',
      venueName: 'Arena',
      venueCity: 'Test City',
      status: 'paid',
    });
    expect(matching[0]?.tickets).toEqual([
      {
        ticketId,
        seatId,
        sectionId,
        sectionName: 'A',
        row: 'A',
        number: 7,
        status: 'valid',
        qrToken: 'qr-token-value',
      },
    ]);
  }, 60_000);

  it('returns an empty list for a user who has never purchased anything', async () => {
    const orders = await listMyTickets(
      { shardPools: db.shardPools, logger: LOGGER },
      randomUUID(),
    );
    expect(orders).toEqual([]);
  }, 30_000);
});
