/**
 * Seedar en köpt-men-ännu-obekräftad order (betalningen väntar på `payment.succeeded`) mot en
 * riktig Postgres. Delas av Pact-verifieringen av meddelanden och analytics-testet.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface Purchase {
  readonly eventId: string;
  readonly orderId: string;
  readonly reservationId: string;
  readonly paymentId: string;
  readonly seatIds: readonly string[];
  readonly userId: string;
}

/** Seedar en betalning som väntar på `payment.succeeded`, med reservationen i valt tillstånd. */
export async function seedPurchase(
  pool: Pool,
  options: { reservationStatus: 'pending_payment' | 'expired'; seatCount: number },
): Promise<Purchase> {
  const eventId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const reservationId = randomUUID();
  const sectionId = randomUUID();
  const seatIds = Array.from({ length: options.seatCount }, () => randomUUID());
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Provider', 'Provider', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days')`,
    [eventId],
  );
  await pool.query(`INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, $3, 'P')`, [
    userId,
    `auth0|${userId}`,
    `${userId}@example.test`,
  ]);
  await pool.query(
    `INSERT INTO reservations (id, event_id, queue_token_id, status, expires_at, release_after,
                               payment_frozen_until)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes', now() + interval '6 minutes',
             now() + interval '10 minutes')`,
    [reservationId, eventId, randomUUID(), options.reservationStatus],
  );
  for (const [index, seatId] of seatIds.entries()) {
    await pool.query(
      `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number,
                          price_cents, status, reservation_id)
       VALUES ($1, $2, gen_random_uuid(), $3, 'A', $4, $5, 39500, 'held', $6)`,
      [seatId, eventId, sectionId, index + 1, `T-${seatId}`, reservationId],
    );
  }
  await pool.query(
    `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [orderId, eventId, userId, reservationId, 39_500 * options.seatCount],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key,
                           amount_cents, status)
     VALUES ($1, $2, 'stripe', $3, $4, $5, 'pending') RETURNING id`,
    [eventId, orderId, `cs_${orderId}`, randomUUID(), 39_500 * options.seatCount],
  );
  return { eventId, orderId, reservationId, paymentId: rows[0]?.id ?? '', seatIds, userId };
}
