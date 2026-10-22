/**
 * Läser en orders `user_id` (docs/plan.md "Betalning"): `order.refunded`
 * bär bara `orderId` (ingen order skapades/fick biljetter i det
 * flödet), så den e-postmottagaren måste slås upp via ordern.
 */
import type { Pool } from 'pg';

export async function getOrderUserId(
  pool: Pool,
  eventId: string,
  orderId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM orders WHERE event_id = $1 AND id = $2',
    [eventId, orderId],
  );
  return rows[0]?.user_id;
}
