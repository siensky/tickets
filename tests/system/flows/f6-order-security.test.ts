/**
 * F6 Orderstatus-säkerhet (docs/plan.md 7.14): en annan användares order
 * är aldrig läsbar.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { call, purchaseSeats, waitForOrderStatus } from '../helpers/api.js';
import { getAccessToken } from '../helpers/auth.js';
import { closePools, createEvent } from '../helpers/db.js';

afterAll(closePools);

describe('F6 orderstatus-säkerhet', () => {
  it('ger 404 när en annan användare läser ordern', async () => {
    const owner = await getAccessToken(1);
    const other = await getAccessToken(2);
    const { eventId } = await createEvent({ seatCount: 3 });
    const { orderId } = await purchaseSeats(eventId, owner, 1);
    await waitForOrderStatus(eventId, orderId, owner, 'paid');

    const response = await call('GET', `/events/${eventId}/orders/${orderId}`, {
      token: other,
    });

    expect(response.status).toBe(404);
  });
});
