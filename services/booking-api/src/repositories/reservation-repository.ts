/**
 * All SQL for the reservation transaction (docs/rules.md §1, §4). Every
 * function here takes an already-open transaction `client` — the
 * service layer owns BEGIN/COMMIT/ROLLBACK via `withTransaction`
 * (@tickets/db).
 */
import type { PoolClient } from 'pg';
import type { InsertedReservation, SeatLockRow } from '../types/reservation.js';

/**
 * Locks the requested seats (docs/plan.md "Concurrency-kärnan").
 * `ORDER BY id` before `FOR UPDATE` is what prevents the deadlock
 * crown-jewel scenario: two overlapping bookings always acquire shared
 * seats in the same order. `NOWAIT` is what turns a collision with
 * scheduler-worker's release job into a fast 409 instead of a stall
 * (accepted trade-off, docs/plan.md).
 *
 * Does NOT decide lazy expiry here — that decision belongs to Postgres
 * (`expireReservations`'s own `release_after < now()`), never to a
 * comparison against the app server's clock (docs/rules.md §4).
 */
export async function lockSeats(
  client: PoolClient,
  eventId: string,
  seatIds: readonly string[],
): Promise<SeatLockRow[]> {
  const { rows } = await client.query<{
    seat_id: string;
    seat_status: string;
    reservation_id: string | null;
  }>(
    `SELECT id AS seat_id, status AS seat_status, reservation_id
     FROM seats
     WHERE event_id = $1 AND id = ANY($2)
     ORDER BY id
     FOR UPDATE NOWAIT`,
    [eventId, seatIds],
  );
  return rows.map((row) => ({
    seatId: row.seat_id,
    seatStatus: row.seat_status,
    reservationId: row.reservation_id,
  }));
}

/** Flips reservations past their jitter deadline to `expired`; returns the ids it actually touched. */
export async function expireReservations(
  client: PoolClient,
  reservationIds: readonly string[],
): Promise<string[]> {
  if (reservationIds.length === 0) {
    return [];
  }
  const { rows } = await client.query<{ id: string }>(
    `UPDATE reservations
     SET status = 'expired'
     WHERE id = ANY($1) AND status = 'active' AND release_after < now()
     RETURNING id`,
    [reservationIds],
  );
  return rows.map((row) => row.id);
}

/** Frees every seat still pointing at one of these (just-expired) reservations. */
export async function releaseSeatsForReservations(
  client: PoolClient,
  reservationIds: readonly string[],
): Promise<void> {
  if (reservationIds.length === 0) {
    return;
  }
  await client.query(
    `UPDATE seats
     SET status = 'available', reservation_id = NULL, updated_at = now()
     WHERE reservation_id = ANY($1)`,
    [reservationIds],
  );
}

/**
 * Inserts the new reservation. `expires_at`/`release_after` are computed
 * with Postgres's own `now()` — never in the app server (pod clock
 * skew) or the client (forgeable), docs/rules.md §4.
 */
export async function insertReservation(
  client: PoolClient,
  params: {
    eventId: string;
    queueTokenId: string;
    holdMinutes: number;
    jitterMaxSeconds: number;
  },
): Promise<InsertedReservation> {
  const { rows } = await client.query<{ id: string; expires_at: Date; release_after: Date }>(
    `INSERT INTO reservations (event_id, queue_token_id, status, expires_at, release_after)
     VALUES (
       $1, $2, 'active',
       now() + ($3 * interval '1 minute'),
       now() + ($3 * interval '1 minute') + (random() * $4 * interval '1 second')
     )
     RETURNING id, expires_at, release_after`,
    [params.eventId, params.queueTokenId, params.holdMinutes, params.jitterMaxSeconds],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertReservation: INSERT ... RETURNING produced no row');
  }
  return { id: row.id, expiresAt: row.expires_at, releaseAfter: row.release_after };
}

export async function attachSeatsToReservation(
  client: PoolClient,
  reservationId: string,
  seatIds: readonly string[],
): Promise<void> {
  await client.query(
    `UPDATE seats SET status = 'held', reservation_id = $1, updated_at = now() WHERE id = ANY($2)`,
    [reservationId, seatIds],
  );
}
