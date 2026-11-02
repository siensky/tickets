/**
 * F7 Skanning (docs/plan.md 7.14): en köpt biljett skannas `ok` och sedan `already_scanned`,
 * fel event ger `not_found`, en token utan permissionen `scan:tickets` ger 403, och databasen
 * har exakt en rad i `ticket_scans`. QR-koden är `tickets.qr_token`, läst med läsande SQL.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, purchaseSeats, waitForOrderStatus } from '../helpers/api.js';
import { getAccessToken } from '../helpers/auth.js';
import { closePools, createEvent, queryBothShards } from '../helpers/db.js';
import { asRecord, str } from '../helpers/json.js';

afterAll(closePools);

function scan(token: string, body: { eventId: string; qrToken: string; gate: string }) {
  return call('POST', '/scans', { token, body });
}

describe('F7 skanning', () => {
  it('godkänner en biljett en gång och avvisar resten', async () => {
    const buyer = await getAccessToken(1);
    const staff = await getAccessToken('staff');
    const { eventId } = await createEvent({ seatCount: 3 });
    const other = await createEvent({ seatCount: 1 });
    const { orderId } = await purchaseSeats(eventId, buyer, 1);
    await waitForOrderStatus(eventId, orderId, buyer, 'paid');
    const [ticket] = await queryBothShards<{ id: string; qr_token: string }>(
      'SELECT id, qr_token FROM tickets WHERE event_id = $1 AND order_id = $2',
      [eventId, orderId],
    );
    const qrToken = ticket?.qr_token ?? '';
    expect(qrToken).toMatch(/^[0-9a-f]{64}$/);

    const first = await scan(staff, { eventId, qrToken, gate: 'Grind A' });
    const second = await scan(staff, { eventId, qrToken, gate: 'Grind B' });
    const wrongEvent = await scan(staff, { eventId: other.eventId, qrToken, gate: 'Grind A' });

    expect(first.status).toBe(200);
    expect(str(asRecord(first.body), 'result')).toBe('ok');
    expect(second.status).toBe(200);
    expect(asRecord(second.body)).toMatchObject({
      result: 'already_scanned',
      gate: 'Grind A',
    });
    expect(asRecord(wrongEvent.body)).toEqual({ result: 'not_found' });
    const scans = await queryBothShards<{ ticket_id: string }>(
      'SELECT ticket_id FROM ticket_scans WHERE event_id = $1',
      [eventId],
    );
    expect(scans).toHaveLength(1);
    expect(scans[0]?.ticket_id).toBe(ticket?.id);
  });

  it('nekar en token utan scan:tickets och en anrop utan token', async () => {
    const buyer = await getAccessToken(1);
    const { eventId } = await createEvent({ seatCount: 1 });
    const body = { eventId, qrToken: 'a'.repeat(64), gate: 'Grind A' };

    expect((await scan(buyer, body)).status).toBe(403);
    expect((await call('POST', '/scans', { body })).status).toBe(401);
  });
});
