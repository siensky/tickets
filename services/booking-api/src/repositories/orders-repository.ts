/**
 * All SQL for `orders` (docs/plan.md "Databas"). Created at CHECKOUT
 * time with `status = 'pending'`, not after payment succeeds — the
 * `payments` table has a NOT NULL foreign key to `orders`, so a payment
 * row (also written at checkout time, see payments-repository.ts) needs
 * an order to point at before Stripe has even been asked to charge
 * anything.
 *
 * `id` is supplied by the CALLER (not `gen_random_uuid()`'s own
 * default) — checkout-service.ts generates it before ever calling
 * Stripe, specifically so it can put the order id into the Checkout
 * Session's `metadata` at creation time. Without that, the webhook
 * would have no way to find this order from the event Stripe sends
 * back (docs/plan.md "Betalning": "verifiera signatur → dedupe →
 * skriv till outbox").
 */
import type { PoolClient } from 'pg';
import type { InsertedOrder, OrderForPayment } from '../types/payment.js';

export async function insertPendingOrder(
  client: PoolClient,
  params: {
    id: string;
    eventId: string;
    userId: string;
    reservationId: string;
    totalCents: number;
  },
): Promise<InsertedOrder> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [params.id, params.eventId, params.userId, params.reservationId, params.totalCents],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertPendingOrder: INSERT ... RETURNING produced no row');
  }
  return { id: row.id };
}

export async function getOrderForPayment(
  client: PoolClient,
  eventId: string,
  orderId: string,
): Promise<OrderForPayment | undefined> {
  const { rows } = await client.query<{
    id: string;
    event_id: string;
    user_id: string;
    reservation_id: string | null;
    total_cents: number;
  }>(
    'SELECT id, event_id, user_id, reservation_id, total_cents FROM orders WHERE event_id = $1 AND id = $2',
    [eventId, orderId],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    reservationId: row.reservation_id,
    totalCents: row.total_cents,
  };
}

export async function markOrderStatus(
  client: PoolClient,
  eventId: string,
  orderId: string,
  fromStatus: string,
  toStatus: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    'UPDATE orders SET status = $4 WHERE event_id = $1 AND id = $2 AND status = $3',
    [eventId, orderId, fromStatus, toStatus],
  );
  return rowCount === 1;
}
