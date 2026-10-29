/**
 * F1 Helt köp (docs/plan.md 7.14): kö → reservation → checkout → betalning →
 * betald order med biljetter, kontrollerat via API:t och databasen.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  call,
  checkout,
  followCheckoutUrl,
  joinAndAdmit,
  listAvailableSeats,
  listSectionIds,
  reserve,
  waitForOrderStatus,
} from '../helpers/api.js';
import { getAccessToken } from '../helpers/auth.js';
import { closePools, createEvent, queryBothShards } from '../helpers/db.js';
import { asArray, asRecord, num, str } from '../helpers/json.js';

afterAll(closePools);

describe('F1 helt köp', () => {
  it('köper två stolar och ger en betald order med två giltiga biljetter', async () => {
    const token = await getAccessToken(1);
    const { eventId } = await createEvent({ seatCount: 6, priceCents: 45_000 });
    const queueToken = await joinAndAdmit(eventId);

    const [sectionId] = await listSectionIds(eventId);
    const seats = (await listAvailableSeats(eventId, sectionId ?? '')).slice(0, 2);
    expect(seats).toHaveLength(2);
    const expectedTotal = seats.reduce((sum, seat) => sum + seat.priceCents, 0);

    const reserved = await reserve(
      eventId,
      queueToken,
      seats.map((seat) => seat.seatId),
    );
    expect(reserved.status).toBe(201);
    const reservationId = str(asRecord(reserved.body), 'reservationId');

    const view = await call('GET', `/events/${eventId}/reservations/${reservationId}`, {
      queueToken,
    });
    const reservation = asRecord(view.body);
    expect(asArray(reservation['seats'])).toHaveLength(2);
    expect(num(reservation, 'totalCents')).toBe(expectedTotal);

    const started = await checkout(eventId, reservationId, queueToken, token);
    expect(started.status).toBe(201);
    const orderId = str(asRecord(started.body), 'orderId');
    const success = new URL(
      await followCheckoutUrl(str(asRecord(started.body), 'checkoutUrl')),
    );
    expect(success.searchParams.get('order_id')).toBe(orderId);
    expect(success.searchParams.get('event_id')).toBe(eventId);

    const order = await waitForOrderStatus(eventId, orderId, token, 'paid');
    expect(num(order, 'totalCents')).toBe(expectedTotal);
    expect(num(order, 'ticketCount')).toBe(2);

    const tickets = await queryBothShards<{ qr_token: string; status: string }>(
      'SELECT qr_token, status FROM tickets WHERE event_id = $1 AND order_id = $2',
      [eventId, orderId],
    );
    expect(tickets).toHaveLength(2);
    expect(tickets.every((ticket) => ticket.status === 'valid')).toBe(true);
    expect(new Set(tickets.map((ticket) => ticket.qr_token)).size).toBe(2);
    const sold = await queryBothShards<{ id: string }>(
      `SELECT id FROM seats WHERE event_id = $1 AND status = 'sold'`,
      [eventId],
    );
    expect(sold.map((seat) => seat.id).sort()).toEqual(
      seats.map((seat) => seat.seatId).sort(),
    );

    const mine = await call('GET', '/me/tickets', { token });
    const myOrders = asArray(asRecord(mine.body)['orders']).map(asRecord);
    const mineOrder = myOrders.find((candidate) => candidate['orderId'] === orderId);
    expect(asArray(mineOrder?.['tickets'])).toHaveLength(2);
  });

  it('avvisar orderstatus utan inloggning', async () => {
    const response = await call('GET', `/events/${randomUUID()}/orders/${randomUUID()}`);
    expect(response.status).toBe(401);
  });
});
