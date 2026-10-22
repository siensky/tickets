/**
 * All SQL for the periodic jittered release job (docs/plan.md
 * "Concurrency-kärnan": "Jittrat frisläpp — innehavaren behåller exakt
 * 5:00; frisläppandet sprids 0–20 s"). Compares against `release_after`,
 * never `expires_at` — otherwise the jitter booking-api wrote at
 * reservation time would be meaningless.
 *
 * Batched with `LIMIT`/`SKIP LOCKED` (docs/plan.md "normal-sale": up to
 * 50 000 reservations can go stale in the same window) — an earlier
 * version expired every due reservation and locked every one of their
 * seats in a single unbounded transaction, which under load turns the
 * plan's "occasional false 409 in the p99 tail" budget into periodic
 * mass-409 bursts every time this job's tick lands on a pile-up.
 */
import type { PoolClient } from 'pg';

const BATCH_SIZE = 500;

export async function expireDueReservationsBatch(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM reservations
       WHERE status = 'active' AND release_after < now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE reservations
     SET status = 'expired'
     WHERE id IN (SELECT id FROM due)
     RETURNING id`,
    [BATCH_SIZE],
  );
  return rows.map((row) => row.id);
}

/**
 * Frysningens eget tak (docs/plan.md "Betalning": "Eget tak via
 * `payment_frozen_until` ... annars blir frysningen ett sätt att hålla
 * stolar gratis"). En betalning som ändå landar EFTER att det här hunnit
 * köra är precis skyddsnät-fallet payment-consumer-service.ts hanterar
 * (automatisk återbetalning) — denna frågan vet ingenting om det, den
 * bara friger stolarna.
 */
export async function expireDueFrozenReservationsBatch(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM reservations
       WHERE status = 'pending_payment' AND payment_frozen_until < now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE reservations
     SET status = 'expired'
     WHERE id IN (SELECT id FROM due)
     RETURNING id`,
    [BATCH_SIZE],
  );
  return rows.map((row) => row.id);
}

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
