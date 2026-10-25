/**
 * All SQL for the reservation transaction (docs/rules.md §1, §4). Every
 * function here takes an already-open transaction `client` — the
 * service layer owns BEGIN/COMMIT/ROLLBACK via `withTransaction`
 * (@tickets/db).
 */
import { isLockNotAvailable } from '@tickets/db';
import type { Pool, PoolClient } from 'pg';
import type {
  InsertedReservation,
  ReservationStatus,
  ReservationWithSeatsRow,
  SeatLockOutcome,
  SeatLockRow,
} from '../types/reservation.js';

/**
 * Locks the requested seats ONE AT A TIME, in sorted id order, each
 * with its own `FOR UPDATE NOWAIT` (docs/plan.md "Concurrency-kärnan").
 *
 * One lock per seat (not one `WHERE id = ANY(...)` query) is what lets
 * this report EXACTLY which seat(s) were actually contended —
 * `SeatUnavailableError`'s contract (docs/rules.md §5) is "which seats
 * were taken", and a single batched `FOR UPDATE NOWAIT` fails the
 * whole statement without telling you which row blocked it.
 *
 * The sorted order is what prevents the deadlock crown-jewel scenario:
 * two overlapping bookings always acquire shared seats in the same
 * order, regardless of which order the caller listed them in. `NOWAIT`
 * is what turns a collision with scheduler-worker's release job into a
 * fast 409 instead of a stall (accepted trade-off, docs/plan.md).
 *
 * Does NOT decide lazy expiry here — that decision belongs to Postgres
 * (`releaseExpiredSeatsAmong`'s own `release_after < now()`), never to
 * a comparison against the app server's clock (docs/rules.md §4).
 *
 * Each attempt runs inside its own `SAVEPOINT`. A `NOWAIT` failure
 * aborts the current transaction in Postgres, same as any other SQL
 * error — catching it in application code does NOT make the
 * transaction usable again. Without the savepoint, the very next
 * statement (the next seat's lock attempt, or anything later in the
 * same transaction) fails with a generic "current transaction is
 * aborted" (25P02), not the seat-unavailable condition this is
 * actually trying to detect. `ROLLBACK TO SAVEPOINT` is what undoes
 * just the failed attempt and leaves the transaction usable again.
 */
export async function lockSeats(
  client: PoolClient,
  eventId: string,
  seatIds: readonly string[],
): Promise<SeatLockOutcome> {
  const locked: SeatLockRow[] = [];
  const lockFailedSeatIds: string[] = [];

  for (const seatId of [...seatIds].sort()) {
    await client.query('SAVEPOINT lock_seat_attempt');
    try {
      const { rows } = await client.query<{
        seat_id: string;
        seat_status: string;
        reservation_id: string | null;
      }>(
        `SELECT id AS seat_id, status AS seat_status, reservation_id
         FROM seats
         WHERE event_id = $1 AND id = $2
         FOR UPDATE NOWAIT`,
        [eventId, seatId],
      );
      await client.query('RELEASE SAVEPOINT lock_seat_attempt');
      const row = rows[0];
      if (row !== undefined) {
        locked.push({
          seatId: row.seat_id,
          seatStatus: row.seat_status,
          reservationId: row.reservation_id,
        });
      }
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT lock_seat_attempt');
      if (!isLockNotAvailable(error)) {
        throw error;
      }
      lockFailedSeatIds.push(seatId);
    }
  }

  return { locked, lockFailedSeatIds };
}

/**
 * Among seats this transaction ALREADY holds a `FOR UPDATE` lock on
 * (from `lockSeats`, same transaction, same connection), frees the ones
 * whose current holder has expired — decided by Postgres's own
 * `now()` in the subquery, never the app server's clock. If that was
 * the LAST held seat of its reservation, also flips the reservation
 * itself to `expired`, so the queue token's "one active reservation"
 * slot frees up immediately instead of waiting for the periodic job.
 *
 * Deliberately touches ONLY the caller's own already-locked seat ids
 * for the seats UPDATE, and only ever conditionally updates a
 * reservation BY ID, never by scanning or locking any OTHER seat to
 * decide it. A prior version additionally released every sibling seat
 * of the stale reservation here, including ones this request never
 * asked for and never locked — that cross-table, cross-seat write is
 * exactly what let two concurrent requests for *different* seats of
 * the *same* expired multi-seat reservation deadlock (ABBA: request A
 * locks seat 1 then blocks writing seat 2, while request B locks seat
 * 2 then blocks writing seat 1). The reservation UPDATE below can only
 * ever create a one-way wait (whoever gets there first wins, the loser
 * just waits for them to commit) — never a cycle — because it's the
 * only resource two such requests could still contend on.
 *
 * Accepted consequence: if two concurrent requests each lazily release
 * a DIFFERENT seat of the SAME stale multi-seat reservation AT THE
 * EXACT SAME TIME (before either has committed), each can see the
 * OTHER's seat as still `held` and conclude the reservation isn't
 * fully empty yet — so neither flips it, and it briefly sits `active`
 * with zero seats held. Narrower than it sounds (needs near-exact
 * concurrency, not just "two requests close together"), and
 * self-heals on the periodic release job's next tick regardless, same
 * as before.
 */
export async function releaseExpiredSeatsAmong(
  client: PoolClient,
  eventId: string,
  seatIds: readonly string[],
): Promise<string[]> {
  if (seatIds.length === 0) {
    return [];
  }
  // `RETURNING` reflects the row AFTER the UPDATE applies — plain
  // `RETURNING reservation_id` here would return the NULL we just set,
  // not the stale reservation it used to point to. Joining against a
  // CTE captured BEFORE the UPDATE (`to_release`) is what gets the OLD
  // value and the new row in one statement.
  const { rows } = await client.query<{ id: string; reservation_id: string }>(
    `WITH to_release AS (
       SELECT id, reservation_id
       FROM seats
       WHERE event_id = $1 AND id = ANY($2) AND status = 'held'
         AND reservation_id IN (
           SELECT id FROM reservations WHERE status = 'active' AND release_after < now()
         )
     )
     UPDATE seats
     SET status = 'available', reservation_id = NULL, updated_at = now()
     FROM to_release
     WHERE seats.id = to_release.id
     RETURNING seats.id, to_release.reservation_id`,
    [eventId, seatIds],
  );
  if (rows.length === 0) {
    return [];
  }

  const touchedReservationIds = [...new Set(rows.map((row) => row.reservation_id))];
  await client.query(
    `UPDATE reservations
     SET status = 'expired'
     WHERE id = ANY($1) AND status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM seats WHERE seats.reservation_id = reservations.id AND seats.status = 'held'
       )`,
    [touchedReservationIds],
  );
  return rows.map((row) => row.id);
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

/**
 * Plain read outside any write transaction — `GET /reservations/:id`
 * (docs/plan.md "Realtid": "läsbart tillstånd klienten kan läsa om vid
 * återanslutning"). `COALESCE(..., '{}')` keeps a reservation with no
 * (or not-yet-attached) seats from turning the join into NULL.
 */
export async function getReservationWithSeats(
  pool: Pool,
  eventId: string,
  reservationId: string,
): Promise<ReservationWithSeatsRow | undefined> {
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    queue_token_id: string;
    status: ReservationStatus;
    expires_at: Date;
    seat_ids: string[] | null;
  }>(
    `SELECT r.id, r.event_id, r.queue_token_id, r.status, r.expires_at,
            ARRAY_REMOVE(ARRAY_AGG(s.id), NULL) AS seat_ids
     FROM reservations r
     LEFT JOIN seats s ON s.reservation_id = r.id
     WHERE r.event_id = $1 AND r.id = $2
     GROUP BY r.id`,
    [eventId, reservationId],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    eventId: row.event_id,
    queueTokenId: row.queue_token_id,
    status: row.status,
    expiresAt: row.expires_at,
    seatIds: row.seat_ids ?? [],
  };
}

export async function attachSeatsToReservation(
  client: PoolClient,
  eventId: string,
  reservationId: string,
  seatIds: readonly string[],
): Promise<void> {
  await client.query(
    `UPDATE seats
     SET status = 'held', reservation_id = $1, updated_at = now()
     WHERE event_id = $2 AND id = ANY($3)`,
    [reservationId, eventId, seatIds],
  );
}

/**
 * Seats currently held BY THIS RESERVATION, with their price
 * (docs/plan.md "Säkerhet": "Priser beräknas alltid på servern från
 * databasen" — never from anything the client sends). Scoping on
 * `reservation_id = $2` (not a client-supplied seat-id list) is what
 * makes the checkout total trustworthy.
 */
export async function getSeatPricesForReservation(
  client: Pool | PoolClient,
  eventId: string,
  reservationId: string,
): Promise<readonly { seatId: string; priceCents: number }[]> {
  const { rows } = await client.query<{ id: string; price_cents: number }>(
    'SELECT id, price_cents FROM seats WHERE event_id = $1 AND reservation_id = $2',
    [eventId, reservationId],
  );
  return rows.map((row) => ({ seatId: row.id, priceCents: row.price_cents }));
}

/**
 * Flips the reservation's held seats to `sold` once payment is
 * confirmed. Must run in the SAME transaction as `markReservationConverted`
 * — otherwise the invariant in docs/plan.md "Databas" ("varje stol med
 * `status='held'` har ett `reservation_id` som pekar på en aktiv
 * reservation, och omvänt") breaks the moment the reservation flips to
 * `converted` while its seats are still `held`.
 */
export async function markSeatsSold(
  client: PoolClient,
  eventId: string,
  reservationId: string,
): Promise<void> {
  await client.query(
    `UPDATE seats SET status = 'sold', updated_at = now()
     WHERE event_id = $1 AND reservation_id = $2 AND status = 'held'`,
    [eventId, reservationId],
  );
}

/**
 * Undoes `markSeatsSold` for a SINGLE seat whose ticket insert then lost
 * the `tickets_valid_seat_unique` race (docs/plan.md "Oversell") — without
 * this, that seat would stay `sold` under a reservation that never got a
 * ticket for it: permanently unsellable, no record of why. Scoped to
 * `reservation_id = $3` so it's a no-op if the seat's already been
 * reassigned to whoever actually holds the valid ticket by the time this
 * runs — never clobbers another order's settled ownership of the seat.
 */
export async function releaseConflictedSeat(
  client: PoolClient,
  eventId: string,
  seatId: string,
  reservationId: string,
): Promise<void> {
  await client.query(
    `UPDATE seats SET status = 'available', reservation_id = NULL, updated_at = now()
     WHERE event_id = $1 AND id = $2 AND reservation_id = $3 AND status = 'sold'`,
    [eventId, seatId, reservationId],
  );
}

/**
 * Starts the payment freeze (docs/plan.md "Betalning": Checkout
 * creation "slutar räkna ner"). The conditional `WHERE status =
 * 'active'` is what makes "en aktiv Checkout per kötoken" hold — a
 * second concurrent checkout attempt against the same reservation
 * finds 0 rows and must treat that as already-in-progress, never
 * silently succeed twice.
 */
export async function markReservationPendingPayment(
  client: PoolClient,
  eventId: string,
  reservationId: string,
  paymentFrozenMinutes: number,
): Promise<boolean> {
  // `expires_at > now()` (Postgres's own clock, docs/rules.md §4): without
  // it a checkout started right as the 5-minute hold runs out could freeze
  // a reservation that lazy expiry just hasn't gotten around to reclaiming
  // yet — charging the customer for seats about to be handed to someone
  // else.
  const { rowCount } = await client.query(
    `UPDATE reservations
     SET status = 'pending_payment', payment_frozen_until = now() + ($3 * interval '1 minute')
     WHERE event_id = $1 AND id = $2 AND status = 'active' AND expires_at > now()`,
    [eventId, reservationId, paymentFrozenMinutes],
  );
  return rowCount === 1;
}

export async function getReservationStatus(
  client: PoolClient,
  eventId: string,
  reservationId: string,
): Promise<ReservationStatus | undefined> {
  const { rows } = await client.query<{ status: ReservationStatus }>(
    'SELECT status FROM reservations WHERE event_id = $1 AND id = $2',
    [eventId, reservationId],
  );
  return rows[0]?.status;
}

/**
 * Converts a frozen reservation once payment is confirmed. Returns
 * `false` if the reservation is no longer `pending_payment` — the
 * freeze window already expired and the seats were reclaimed before
 * the payment confirmation arrived (docs/plan.md "Betalning som landar
 * efter utgången reservation"), which the caller must treat as a
 * refund case, never as success.
 */
export async function markReservationConverted(
  client: PoolClient,
  eventId: string,
  reservationId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE reservations SET status = 'converted' WHERE event_id = $1 AND id = $2 AND status = 'pending_payment'`,
    [eventId, reservationId],
  );
  return rowCount === 1;
}
