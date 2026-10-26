/**
 * All SQL för `scripts/generate-sale-report.ts` (docs/rules.md §4: "All
 * SQL i repositories/"). Samma "kronjuvel"-fråga som docs/plan.md
 * "Rapport och reset" beskriver: bevis att sålda biljetter ≤ 5 000 och
 * att inget `ticket_number` förekommer i mer än en order.
 */
import type { Pool } from 'pg';

export interface SaleProof {
  readonly soldTicketCount: number;
  readonly soldWithinInventory: boolean;
  readonly duplicateTicketNumbers: readonly string[];
}

export async function querySaleProof(pool: Pool, eventId: string): Promise<SaleProof> {
  const sold = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM tickets WHERE event_id = $1 AND status = 'valid'",
    [eventId],
  );
  const soldTicketCount = Number(sold.rows[0]?.count ?? 0);

  const duplicates = await pool.query<{ ticket_number: string }>(
    `SELECT s.ticket_number
     FROM tickets t
     JOIN seats s ON s.id = t.seat_id
     WHERE t.event_id = $1 AND t.status = 'valid'
     GROUP BY s.ticket_number
     HAVING COUNT(DISTINCT t.order_id) > 1`,
    [eventId],
  );

  return {
    soldTicketCount,
    soldWithinInventory: soldTicketCount <= 5000,
    duplicateTicketNumbers: duplicates.rows.map((row) => row.ticket_number),
  };
}

/** Antal slutförda köp (docs/plan.md "Rapport och reset": "antal slutförda köp"). */
export async function queryCompletedPurchaseCount(
  pool: Pool,
  eventId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM orders WHERE event_id = $1 AND status = 'paid'",
    [eventId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
