/**
 * F4 Dubbel webhook (docs/plan.md 7.14): payment-mock skickar alltid
 * dubbla webhooks i test-stacken (`PAYMENT_MOCK_DUPLICATE_WEBHOOK_RATE=1`),
 * så idempotensen testas varje gång.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { purchaseSeats, waitForOrderStatus } from '../helpers/api.js';
import { getAccessToken } from '../helpers/auth.js';
import { closePools, createEvent, queryBothShards } from '../helpers/db.js';
import { expectStable } from '../helpers/wait-for.js';

afterAll(closePools);

describe('F4 dubbel webhook', () => {
  it('ger exakt en betald order och två biljetter, aldrig fyra', async () => {
    const token = await getAccessToken(1);
    const { eventId } = await createEvent({ seatCount: 4 });
    const { orderId } = await purchaseSeats(eventId, token, 2);
    await waitForOrderStatus(eventId, orderId, token, 'paid');

    const counts = async (): Promise<{ paid: number; tickets: number }> => {
      const orders = await queryBothShards<{ id: string }>(
        `SELECT id FROM orders WHERE event_id = $1 AND status = 'paid'`,
        [eventId],
      );
      const tickets = await queryBothShards<{ id: string }>(
        `SELECT id FROM tickets WHERE event_id = $1`,
        [eventId],
      );
      return { paid: orders.length, tickets: tickets.length };
    };
    // Dubbletten kommer strax efter originalet. Att ingenting läggs till är bevisat
    // genom att räkningen håller över ett fönster, inte genom en fast väntan.
    await expectStable('one paid order and exactly two tickets', async () => {
      const current = await counts();
      return current.paid === 1 && current.tickets === 2;
    });
    expect(await counts()).toEqual({ paid: 1, tickets: 2 });
  });
});
