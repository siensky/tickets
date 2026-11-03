/**
 * Retention för `reservations` (docs/plan.md "Databas": 30 dagar). Bara avslutade reservationer
 * raderas: `active` och `pending_payment` hör till pågående köp och är aldrig kandidater, oavsett ålder.
 * Ordrar, biljetter och stolar pekar på reservationen utan främmande nyckel (se migrationerna för
 * `orders` och `seats`), så radering kan varken misslyckas tyst eller ta med sig något annat.
 *
 * Batchad med `LIMIT`/`SKIP LOCKED` så en stor första rensning aldrig blir en enda lång transaktion.
 */
import type { Pool } from 'pg';

const BATCH_SIZE = 1000;

/** Returnerar hur många rader som raderades; färre än `BATCH_SIZE` betyder att det inte finns mer att ta. */
export async function deleteExpiredReservationsBatch(
  pool: Pool,
  retentionDays: number,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM reservations
     WHERE id IN (
       SELECT id FROM reservations
       WHERE status IN ('converted', 'expired', 'cancelled')
         AND created_at < now() - ($1 * interval '1 day')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )`,
    [retentionDays, BATCH_SIZE],
  );
  return rowCount ?? 0;
}

export const RESERVATION_RETENTION_BATCH_SIZE = BATCH_SIZE;
