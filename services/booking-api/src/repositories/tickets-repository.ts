/**
 * All SQL for `tickets` (docs/plan.md "Databas"). `qr_token` is
 * computed by the caller (services/qr-token.ts — an HMAC, not a plain
 * hash, docs/rules.md §6) and just stored here; this file never touches
 * the signing secret.
 */
import type { Pool, PoolClient } from 'pg';
import type { TicketWithSeatRow } from '../types/my-tickets.js';

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
 * Every ticket (any status) for a set of orders, joined with its seat's
 * row/number/section for display — "mina biljetter" (docs/plan.md).
 * `orderIds` are already scoped to the caller's own user by
 * `getOrdersForUser` before this is called, so no separate user check
 * is needed here. `eventIds` is the matching set of event ids for
 * those same orders — redundant in theory (an order_id only ever
 * belongs to one event), but included anyway (docs/rules.md §4:
 * shard-nyckel i varje fråga) so a bug elsewhere that mixed up order
 * ids across events can't leak a ticket through this query.
 */
export async function getTicketsWithSeatsForOrders(
  client: Pool | PoolClient,
  orderIds: readonly string[],
  eventIds: readonly string[],
): Promise<TicketWithSeatRow[]> {
  if (orderIds.length === 0) {
    return [];
  }
  const { rows } = await client.query<{
    id: string;
    order_id: string;
    seat_id: string;
    qr_token: string;
    status: string;
    row: string;
    number: number;
    section_id: string;
  }>(
    `SELECT t.id, t.order_id, t.seat_id, t.qr_token, t.status, s.row, s.number, s.section_id
     FROM tickets t
     JOIN seats s ON s.id = t.seat_id AND s.event_id = t.event_id
     WHERE t.order_id = ANY($1) AND t.event_id = ANY($2)`,
    [orderIds, eventIds],
  );
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    seatId: row.seat_id,
    qrToken: row.qr_token,
    status: row.status,
    row: row.row,
    number: row.number,
    sectionId: row.section_id,
  }));
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
