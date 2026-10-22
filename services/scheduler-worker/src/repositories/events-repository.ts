/**
 * Läser ett events försäljningsfönster (docs/plan.md "Väntrum": "Stängt
 * försäljningsfönster"). Egen, minimal kopia av booking-apis
 * motsvarighet — se docs/rules.md §1, varje tjänst äger sin egen
 * vertikala skiva.
 *
 * `isAfterClose` beräknas av Postgres (`now()`), inte av anroparen med
 * `new Date()` (docs/rules.md §4) — annars kan olika poddar fatta olika
 * beslut om exakt samma event precis vid fönsterkanten.
 */
import { NotFoundError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { EventSalesWindow } from '../types/queue-config.js';

export async function getEventSalesWindow(
  pool: Pool,
  eventId: string,
): Promise<EventSalesWindow> {
  const { rows } = await pool.query<{ sales_close_at: Date; is_after_close: boolean }>(
    'SELECT sales_close_at, now() > sales_close_at AS is_after_close FROM events WHERE id = $1',
    [eventId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(`Event ${eventId} not found`, { eventId });
  }
  return { salesCloseAt: row.sales_close_at, isAfterClose: row.is_after_close };
}
