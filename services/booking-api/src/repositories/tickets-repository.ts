/**
 * All SQL for `tickets` (docs/plan.md "Databas"). `qr_token` is
 * computed by the caller (services/qr-token.ts — an HMAC, not a plain
 * hash, docs/rules.md §6) and just stored here; this file never touches
 * the signing secret.
 */
import type { PoolClient } from 'pg';

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
