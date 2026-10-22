/**
 * Reads an event's sales window (docs/plan.md "Väntrum": "Stängt
 * försäljningsfönster ... eget tillstånd"). `events` is shardad på sitt
 * eget `id` (docs/plan.md "Databas") — anroparen måste redan ha hittat
 * rätt pool via `getPoolForEvent`.
 *
 * `isBeforeOpen`/`isAfterClose` beräknas av Postgres (`now()`), inte av
 * anroparen med `new Date()` (docs/rules.md §4: "Tider som systemet
 * litar på beräknas alltid med now() från Postgres — aldrig i
 * appservern") — annars kan poddar med olika klockskev fatta olika
 * beslut om exakt samma event precis vid fönsterkanten.
 */
import { NotFoundError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { EventSalesWindow } from '../types/queue.js';

export async function getEventSalesWindow(
  pool: Pool,
  eventId: string,
): Promise<EventSalesWindow> {
  const { rows } = await pool.query<{
    sales_open_at: Date;
    sales_close_at: Date;
    is_before_open: boolean;
    is_after_close: boolean;
  }>(
    `SELECT sales_open_at, sales_close_at,
            now() < sales_open_at AS is_before_open,
            now() > sales_close_at AS is_after_close
     FROM events WHERE id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(`Event ${eventId} not found`, { eventId });
  }
  return {
    salesOpenAt: row.sales_open_at,
    salesCloseAt: row.sales_close_at,
    isBeforeOpen: row.is_before_open,
    isAfterClose: row.is_after_close,
  };
}
