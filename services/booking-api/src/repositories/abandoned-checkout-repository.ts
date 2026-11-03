/**
 * En övergiven betalning (docs/plan.md "Betalning"): kunden gick till Stripe och kom tillbaka utan att
 * betala. Reservationen står då i `pending_payment` och blockerar annars en ny bokning tills frysningen
 * löpt ut. Bara SQL här; Stripe-anropet och beslutet ligger i services/abandoned-checkout-service.ts.
 */
import type { Pool, PoolClient } from 'pg';

/** Kötokenens reservation i betalning (högst en, partiellt unikt index), valfritt begränsad till ett id. */
export async function findPendingPaymentReservationId(
  pool: Pool,
  eventId: string,
  queueTokenId: string,
  reservationId?: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM reservations
     WHERE event_id = $1 AND queue_token_id = $2 AND status = 'pending_payment'
       AND ($3::uuid IS NULL OR id = $3::uuid)
     LIMIT 1`,
    [eventId, queueTokenId, reservationId ?? null],
  );
  return rows[0]?.id;
}

/** Stripe-sessionens id för orderns väntande betalning (`payments.provider_ref`). */
export async function findPendingStripeSessionId(
  pool: Pool,
  eventId: string,
  orderId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ provider_ref: string }>(
    `SELECT provider_ref FROM payments
     WHERE event_id = $1 AND order_id = $2 AND provider = 'stripe' AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [eventId, orderId],
  );
  return rows[0]?.provider_ref;
}

/**
 * Släpper en reservation i betalning och dess stolar. Anropas först när Stripe bekräftat att sessionen
 * gått ut, alltså aldrig kan betalas. Ordern och betalningsraden lämnas som de är, precis som när
 * frysningen löper ut av sig själv (scheduler-worker). Samma låsordning som
 * `cancelActiveReservationForQueueToken`: reservation före stolar, båda med NOWAIT (55P03 → anroparen
 * försöker igen), stolarna i id-ordning (docs/rules.md §4).
 */
export async function releasePendingPaymentReservation(
  client: PoolClient,
  eventId: string,
  reservationId: string,
): Promise<boolean> {
  const { rows: reservations } = await client.query<{ id: string }>(
    `SELECT id FROM reservations
     WHERE event_id = $1 AND id = $2 AND status = 'pending_payment'
     FOR UPDATE NOWAIT`,
    [eventId, reservationId],
  );
  if (reservations.length === 0) {
    return false;
  }
  const { rows: seats } = await client.query<{ id: string }>(
    `SELECT id FROM seats
     WHERE event_id = $1 AND reservation_id = $2 AND status = 'held'
     ORDER BY id FOR UPDATE NOWAIT`,
    [eventId, reservationId],
  );
  await client.query(
    `UPDATE seats SET status = 'available', reservation_id = NULL, updated_at = now()
     WHERE event_id = $1 AND id = ANY($2)`,
    [eventId, seats.map((row) => row.id)],
  );
  await client.query(
    `UPDATE reservations SET status = 'cancelled' WHERE event_id = $1 AND id = $2`,
    [eventId, reservationId],
  );
  return true;
}
