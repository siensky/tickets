/**
 * All SQL for the periodic jittered release job (docs/plan.md
 * "Concurrency-kärnan": "Jittrat frisläpp — innehavaren behåller exakt
 * 5:00; frisläppandet sprids 0–20 s"). Compares against `release_after`,
 * never `expires_at` — otherwise the jitter booking-api wrote at
 * reservation time would be meaningless.
 */
import type { PoolClient } from 'pg';

export async function expireDueReservations(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE reservations
     SET status = 'expired'
     WHERE status = 'active' AND release_after < now()
     RETURNING id`,
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
