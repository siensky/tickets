/**
 * All SQL för `scripts/reset-sale.ts` (docs/rules.md §4: "All SQL i
 * repositories/"). Tar en redan uttagen `PoolClient`, inte en `Pool` —
 * `BEGIN`/`COMMIT`/`ROLLBACK` måste köras på SAMMA fysiska anslutning
 * (`Pool.query()` kan ge en ANNAN klient per anrop, vilket gjorde att en
 * tidigare version av det här skriptet inte faktiskt körde i en
 * transaktion — upptäckt i Fas 6-reviewn).
 */
import type { PoolClient } from 'pg';

export interface ResetSaleCounts {
  readonly seatsReleased: number;
  readonly reservationsDeleted: number;
  readonly ordersDeleted: number;
  readonly ticketsDeleted: number;
  readonly paymentsDeleted: number;
}

export async function resetSaleForEvent(
  client: PoolClient,
  eventId: string,
): Promise<ResetSaleCounts> {
  await client.query('BEGIN');
  try {
    const seats = await client.query(
      "UPDATE seats SET status = 'available', reservation_id = NULL WHERE event_id = $1",
      [eventId],
    );
    const tickets = await client.query('DELETE FROM tickets WHERE event_id = $1', [eventId]);
    const payments = await client.query('DELETE FROM payments WHERE event_id = $1', [eventId]);
    const orders = await client.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    const reservations = await client.query('DELETE FROM reservations WHERE event_id = $1', [
      eventId,
    ]);
    await client.query('COMMIT');
    return {
      seatsReleased: seats.rowCount ?? 0,
      reservationsDeleted: reservations.rowCount ?? 0,
      ordersDeleted: orders.rowCount ?? 0,
      ticketsDeleted: tickets.rowCount ?? 0,
      paymentsDeleted: payments.rowCount ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
