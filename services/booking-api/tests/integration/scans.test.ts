/**
 * `POST /scans` mot en RIKTIG Postgres (docs/plan.md 7.13 E7, docs/rules.md §8). Auth0 ersätts
 * av en falsk verifierare (token → payload), allt annat är den riktiga koden.
 */
import { randomUUID } from 'node:crypto';
import type { ServerAnalytics } from '@tickets/analytics/server';
import type { Auth0Verifier } from '@tickets/auth';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../../src/routes/error-handler.js';
import { registerScanRoutes } from '../../src/routes/scans.js';
import {
  seedEventForVenue,
  seedOrderWithTicket,
  seedSeatForSection,
  seedUser,
  seedVenueWithSection,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

const STAFF_TOKEN = 'staff-token';
const NO_PERMISSION_TOKEN = 'no-permission-token';
const STAFF_SUB = 'auth0|staff-1';

const verifier: Auth0Verifier = {
  verify(token) {
    if (token === STAFF_TOKEN) {
      return Promise.resolve({
        kind: 'valid',
        payload: { sub: STAFF_SUB, permissions: ['scan:tickets'] },
      });
    }
    if (token === NO_PERMISSION_TOKEN) {
      return Promise.resolve({
        kind: 'valid',
        payload: { sub: 'auth0|guest', permissions: [] },
      });
    }
    return Promise.resolve({ kind: 'invalid', reason: 'bad token' });
  },
};

interface SeededTicket {
  readonly eventId: string;
  readonly qrToken: string;
  readonly ticketId: string;
}

describe('POST /scans', () => {
  let db: TestDatabase;
  const track = vi.fn();
  const analytics: ServerAnalytics = { track, shutdown: () => Promise.resolve() };
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = Fastify();
    registerErrorHandler(app);
    registerScanRoutes(app, { shardPools: db.shardPools, analytics }, verifier);
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase(db);
  });

  beforeEach(() => track.mockClear());

  async function seedTicket(
    status: 'valid' | 'refunded' | 'void' = 'valid',
  ): Promise<SeededTicket> {
    const pool = db.shardPools.pools[0];
    const userId = randomUUID();
    const venueId = randomUUID();
    const sectionId = randomUUID();
    const eventId = randomUUID();
    const seatId = randomUUID();
    const orderId = randomUUID();
    const ticketId = randomUUID();
    const qrToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await seedUser(pool, {
      userId,
      auth0Sub: `auth0|${userId}`,
      email: `${userId}@example.test`,
    });
    await seedVenueWithSection(pool, {
      venueId,
      venueName: 'Arena',
      sectionId,
      sectionName: 'Parkett',
    });
    await seedEventForVenue(pool, { eventId, venueId, title: 'Scan Concert' });
    await seedSeatForSection(pool, {
      seatId,
      eventId,
      venueSeatId: randomUUID(),
      sectionId,
      row: 'C',
      number: 12,
      ticketNumber: `T-${eventId}`,
      status: 'sold',
    });
    await seedOrderWithTicket(pool, { orderId, eventId, userId, seatId, ticketId, qrToken });
    if (status !== 'valid') {
      await pool.query('UPDATE tickets SET status = $1 WHERE id = $2', [status, ticketId]);
    }
    return { eventId, qrToken, ticketId };
  }

  function scan(
    body: unknown,
    token: string | null = STAFF_TOKEN,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/scans',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: body as object,
    });
  }

  it('godkänner en giltig biljett och avvisar nästa skanning som redan skannad', async () => {
    const ticket = await seedTicket();
    const body = { eventId: ticket.eventId, qrToken: ticket.qrToken, gate: 'Grind A' };

    const first = await scan(body);
    const second = await scan({ ...body, gate: 'Grind B' });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      result: 'ok',
      sectionName: 'Parkett',
      row: 'C',
      number: 12,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      result: 'already_scanned',
      scannedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      gate: 'Grind A',
    });
    const { rows } = await db.shardPools.pools[0].query(
      'SELECT scanned_by FROM ticket_scans WHERE ticket_id = $1',
      [ticket.ticketId],
    );
    expect(rows).toEqual([{ scanned_by: STAFF_SUB }]);
    expect(track).toHaveBeenCalledWith(
      STAFF_SUB,
      'ticket_scanned',
      { result: 'ok', gate: 'Grind A' },
      { personless: true },
    );
  }, 60_000);

  it('ger not_found för fel event och för en okänd kod', async () => {
    const ticket = await seedTicket();
    const otherEvent = await seedTicket();

    const wrongEvent = await scan({
      eventId: otherEvent.eventId,
      qrToken: ticket.qrToken,
      gate: 'Grind A',
    });
    const unknown = await scan({
      eventId: ticket.eventId,
      qrToken: 'a'.repeat(64),
      gate: 'Grind A',
    });

    expect(wrongEvent.json()).toEqual({ result: 'not_found' });
    expect(unknown.json()).toEqual({ result: 'not_found' });
  }, 60_000);

  it('ger refunded och void för biljetter som inte längre gäller, utan att registrera en skanning', async () => {
    const refunded = await seedTicket('refunded');
    const voided = await seedTicket('void');

    const refundedResponse = await scan({
      eventId: refunded.eventId,
      qrToken: refunded.qrToken,
      gate: 'Grind A',
    });
    const voidResponse = await scan({
      eventId: voided.eventId,
      qrToken: voided.qrToken,
      gate: 'Grind A',
    });

    expect(refundedResponse.json()).toEqual({ result: 'refunded' });
    expect(voidResponse.json()).toEqual({ result: 'void' });
    const { rows } = await db.shardPools.pools[0].query(
      'SELECT 1 FROM ticket_scans WHERE ticket_id = ANY($1)',
      [[refunded.ticketId, voided.ticketId]],
    );
    expect(rows).toHaveLength(0);
  }, 60_000);

  it('ger exakt en ok när samma biljett skannas samtidigt', async () => {
    const ticket = await seedTicket();
    const body = { eventId: ticket.eventId, qrToken: ticket.qrToken, gate: 'Grind C' };

    const responses = await Promise.all(Array.from({ length: 8 }, () => scan(body)));

    const results = responses.map((response) => response.json<{ result: string }>().result);
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result === 'already_scanned')).toHaveLength(7);
  }, 60_000);

  it('svarar 403 utan permissionen scan:tickets, 401 utan giltigt token och 400 vid ogiltig body', async () => {
    const ticket = await seedTicket();
    const body = { eventId: ticket.eventId, qrToken: ticket.qrToken, gate: 'Grind A' };

    expect((await scan(body, NO_PERMISSION_TOKEN)).statusCode).toBe(403);
    expect((await scan(body, null)).statusCode).toBe(401);
    expect((await scan(body, 'garbage')).statusCode).toBe(401);
    expect((await scan({ ...body, gate: '' })).statusCode).toBe(400);
    expect((await scan({ ...body, extra: true })).statusCode).toBe(400);
    expect((await scan({ ...body, qrToken: 'not-hex' })).statusCode).toBe(400);
    const { rows } = await db.shardPools.pools[0].query(
      'SELECT 1 FROM ticket_scans WHERE ticket_id = $1',
      [ticket.ticketId],
    );
    expect(rows).toHaveLength(0);
  }, 60_000);
});
