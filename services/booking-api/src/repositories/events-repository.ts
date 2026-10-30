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
import type { EventCategory } from '@tickets/schemas';
import { NotFoundError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { EventRow, EventsFilter } from '../types/event.js';
import type { EventTicketInfo } from '../types/my-tickets.js';
import type { EventSalesWindow } from '../types/queue.js';

// Aggregatet över eventets stolar (prisintervall, lediga/totala) räknas i en
// LATERAL-subfråga per event, på samma shard som eventet (docs/plan.md 7.13 E1).
const EVENT_ROW_SELECT = `SELECT e.id, e.venue_id, e.title, e.artist, e.category, e.starts_at,
            e.sales_open_at, e.sales_close_at, e.status, e.image_url, e.description, e.featured,
            now() < e.sales_open_at AS is_before_open, now() > e.sales_close_at AS is_after_close,
            agg.min_price_cents, agg.max_price_cents, agg.available_seats, agg.total_seats
     FROM events e
     LEFT JOIN LATERAL (
       SELECT MIN(s.price_cents) AS min_price_cents,
              MAX(s.price_cents) AS max_price_cents,
              COUNT(*) FILTER (WHERE s.status = 'available') AS available_seats,
              COUNT(*) AS total_seats
       FROM seats s
       WHERE s.event_id = e.id
     ) agg ON true`;

interface RawEventRow {
  id: string;
  venue_id: string;
  title: string;
  artist: string;
  category: EventCategory;
  starts_at: Date;
  sales_open_at: Date;
  sales_close_at: Date;
  status: string;
  is_before_open: boolean;
  is_after_close: boolean;
  image_url: string | null;
  description: string | null;
  featured: boolean;
  min_price_cents: number | null;
  max_price_cents: number | null;
  // COUNT() kommer som bigint, alltså sträng från pg.
  available_seats: string;
  total_seats: string;
}

function toEventRow(row: RawEventRow): EventRow {
  return {
    id: row.id,
    venueId: row.venue_id,
    title: row.title,
    artist: row.artist,
    category: row.category,
    startsAt: row.starts_at,
    salesOpenAt: row.sales_open_at,
    salesCloseAt: row.sales_close_at,
    status: row.status,
    isBeforeOpen: row.is_before_open,
    isAfterClose: row.is_after_close,
    imageKey: row.image_url,
    description: row.description,
    featured: row.featured,
    minPriceCents: row.min_price_cents,
    maxPriceCents: row.max_price_cents,
    availableSeats: Number(row.available_seats),
    totalSeats: Number(row.total_seats),
  };
}

/** One shard's events, for the "välj evenemang" listing (docs/plan.md). Caller merges across both shards. */
/**
 * No `event_id` filter — a deliberate exception to docs/rules.md §4
 * (same documented exception as "mina ordrar via scatter-gather",
 * docs/plan.md "Databas"): a LISTING endpoint has no single event to
 * scope to by definition. The caller queries this once per shard and
 * merges, never joins across shards.
 *
 * `filter` (Fas 6: kategori/sök) builds its WHERE clause from a fixed
 * set of optional conditions, each still parameterized — docs/rules.md
 * §4 ("All SQL parameteriserad") applies just as much to an optional
 * filter as to a required one; only the SQL TEXT branches, never a
 * value gets string-interpolated in.
 */
export async function listEvents(pool: Pool, filter: EventsFilter = {}): Promise<EventRow[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.category !== undefined) {
    params.push(filter.category);
    conditions.push(`e.category = $${String(params.length)}`);
  }
  if (filter.search !== undefined) {
    params.push(`%${filter.search}%`);
    conditions.push(
      `(e.title ILIKE $${String(params.length)} OR e.artist ILIKE $${String(params.length)})`,
    );
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query<RawEventRow>(
    `${EVENT_ROW_SELECT}${where} ORDER BY e.starts_at ASC`,
    params,
  );
  return rows.map(toEventRow);
}

export async function getEventById(
  pool: Pool,
  eventId: string,
): Promise<EventRow | undefined> {
  const { rows } = await pool.query<RawEventRow>(`${EVENT_ROW_SELECT} WHERE e.id = $1`, [
    eventId,
  ]);
  const row = rows[0];
  return row === undefined ? undefined : toEventRow(row);
}

/** Batch lookup of title, start time and venue for "mina biljetter" (docs/plan.md "Mina ordrar", 7.13 E9), where several orders on the same shard can reference different events. */
export async function getEventTicketInfoByIds(
  pool: Pool,
  eventIds: readonly string[],
): Promise<Map<string, EventTicketInfo>> {
  if (eventIds.length === 0) {
    return new Map();
  }
  const { rows } = await pool.query<{
    id: string;
    title: string;
    starts_at: Date;
    venue_id: string;
  }>('SELECT id, title, starts_at, venue_id FROM events WHERE id = ANY($1)', [eventIds]);
  return new Map(
    rows.map((row) => [
      row.id,
      { title: row.title, startsAt: row.starts_at, venueId: row.venue_id },
    ]),
  );
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
