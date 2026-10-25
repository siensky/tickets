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
import type { EventRow } from '../types/event.js';
import type { EventSalesWindow } from '../types/queue.js';

const EVENT_ROW_SELECT = `SELECT id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at,
            status, now() < sales_open_at AS is_before_open, now() > sales_close_at AS is_after_close
     FROM events`;

interface RawEventRow {
  id: string;
  venue_id: string;
  title: string;
  artist: string;
  starts_at: Date;
  sales_open_at: Date;
  sales_close_at: Date;
  status: string;
  is_before_open: boolean;
  is_after_close: boolean;
}

function toEventRow(row: RawEventRow): EventRow {
  return {
    id: row.id,
    venueId: row.venue_id,
    title: row.title,
    artist: row.artist,
    startsAt: row.starts_at,
    salesOpenAt: row.sales_open_at,
    salesCloseAt: row.sales_close_at,
    status: row.status,
    isBeforeOpen: row.is_before_open,
    isAfterClose: row.is_after_close,
  };
}

/** One shard's events, for the "välj evenemang" listing (docs/plan.md). Caller merges across both shards. */
/**
 * No `event_id` filter — a deliberate exception to docs/rules.md §4
 * (same documented exception as "mina ordrar via scatter-gather",
 * docs/plan.md "Databas"): a LISTING endpoint has no single event to
 * scope to by definition. The caller queries this once per shard and
 * merges, never joins across shards.
 */
export async function listEvents(pool: Pool): Promise<EventRow[]> {
  const { rows } = await pool.query<RawEventRow>(`${EVENT_ROW_SELECT} ORDER BY starts_at ASC`);
  return rows.map(toEventRow);
}

export async function getEventById(
  pool: Pool,
  eventId: string,
): Promise<EventRow | undefined> {
  const { rows } = await pool.query<RawEventRow>(`${EVENT_ROW_SELECT} WHERE id = $1`, [
    eventId,
  ]);
  const row = rows[0];
  return row === undefined ? undefined : toEventRow(row);
}

/** Batch title lookup for "mina biljetter" (docs/plan.md "Mina ordrar"), where several orders on the same shard can reference different events. */
export async function getEventTitlesByIds(
  pool: Pool,
  eventIds: readonly string[],
): Promise<Map<string, string>> {
  if (eventIds.length === 0) {
    return new Map();
  }
  const { rows } = await pool.query<{ id: string; title: string }>(
    'SELECT id, title FROM events WHERE id = ANY($1)',
    [eventIds],
  );
  return new Map(rows.map((row) => [row.id, row.title]));
}

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
