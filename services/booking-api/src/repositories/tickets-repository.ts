/**
 * All SQL for `tickets` (docs/plan.md "Databas"). `qr_token` is
 * computed by the caller (services/qr-token.ts — an HMAC, not a plain
 * hash, docs/rules.md §6) and just stored here; this file never touches
 * the signing secret.
 */
import type { Pool, PoolClient } from 'pg';

export async function insertTicket(
  client: PoolClient,
  params: { eventId: string; orderId: string; seatId: string; qrToken: string },
): Promise<{ id: string }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tickets (event_id, order_id, seat_id, qr_token, status)
     VALUES ($1, $2, $3, $4, 'valid')
     RETURNING id`,
    [params.eventId, params.orderId, params.seatId, params.qrToken],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertTicket: INSERT ... RETURNING produced no row');
  }
  return { id: row.id };
}

/**
 * Which of this order's seats already have a valid ticket — used to
 * recompute a partial-refund-after-oversell-conflict's seat list on a
 * redelivered `payment.succeeded` message (docs/plan.md "Oversell"),
 * instead of a separate durable "pending refund" marker: the ticket rows
 * themselves are already the durable source of truth for who got what.
 */
export async function getTicketedSeatIds(
  client: Pool | PoolClient,
  eventId: string,
  orderId: string,
): Promise<readonly string[]> {
  const { rows } = await client.query<{ seat_id: string }>(
    `SELECT seat_id FROM tickets WHERE event_id = $1 AND order_id = $2 AND status = 'valid'`,
    [eventId, orderId],
  );
  return rows.map((row) => row.seat_id);
}
