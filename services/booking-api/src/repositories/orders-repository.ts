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
import type { Pool, PoolClient } from 'pg';
import type { InsertedOrder, OrderForPayment } from '../types/payment.js';
import type { OrderRow } from '../types/my-tickets.js';
import type { OrderStatus, OrderStatusRow } from '../types/order.js';

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

/**
 * All of this shard's orders for a user (docs/plan.md "Databas": "Mina
 * ordrar via scatter-gather" — `user_id` has no FK, so there is no
 * single `event_id` to filter on here; the caller queries both shards
 * and merges, which is the documented exception to docs/rules.md §4's
 * shard-key rule).
 */
export async function getOrdersForUser(pool: Pool, userId: string): Promise<OrderRow[]> {
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    status: string;
    total_cents: number;
    created_at: Date;
  }>(
    'SELECT id, event_id, status, total_cents, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  }));
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

/**
 * En orders status och antal biljetter för bekräftelsesidan (docs/plan.md
 * 7.13 E6). Scopad på `user_id` (docs/rules.md §6: IDOR): en annans order
 * ger samma `undefined` som en som inte finns. `event_id` i båda frågorna.
 */
export async function getOrderForUser(
  pool: Pool,
  eventId: string,
  orderId: string,
  userId: string,
): Promise<OrderStatusRow | undefined> {
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    status: OrderStatus;
    total_cents: number;
    ticket_count: string;
  }>(
    `SELECT o.id, o.event_id, o.status, o.total_cents,
            (SELECT COUNT(*) FROM tickets t
              WHERE t.event_id = o.event_id AND t.order_id = o.id) AS ticket_count
     FROM orders o
     WHERE o.event_id = $1 AND o.id = $2 AND o.user_id = $3`,
    [eventId, orderId, userId],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    totalCents: row.total_cents,
    // COUNT() kommer som bigint, alltså sträng från pg.
    ticketCount: Number(row.ticket_count),
  };
}
