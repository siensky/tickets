/**
 * All SQL for `venues`/`venue_sections`/`venue_seats` (docs/plan.md
 * "Databas"). Global, shard-0-only tables — every function here takes
 * the GLOBAL pool (`getGlobalPool`), never a per-event pool.
 */
import type { Pool } from 'pg';
import type { VenueRow, VenueSeatGeometryRow, VenueSectionRow } from '../types/venue.js';

interface RawVenueRow {
  id: string;
  name: string;
  city: string;
}

export async function getVenueById(
  pool: Pool,
  venueId: string,
): Promise<VenueRow | undefined> {
  const { rows } = await pool.query<RawVenueRow>(
    'SELECT id, name, city FROM venues WHERE id = $1',
    [venueId],
  );
  return rows[0];
}

/** Batch lookup for listing events, where several rows may share a venue. */
export async function getVenuesByIds(
  pool: Pool,
  venueIds: readonly string[],
): Promise<Map<string, VenueRow>> {
  if (venueIds.length === 0) {
    return new Map();
  }
  const { rows } = await pool.query<RawVenueRow>(
    'SELECT id, name, city FROM venues WHERE id = ANY($1)',
    [venueIds],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

interface RawVenueSectionRow {
  id: string;
  name: string;
  display_order: number;
}

export async function listSectionsForVenue(
  pool: Pool,
  venueId: string,
): Promise<VenueSectionRow[]> {
  const { rows } = await pool.query<RawVenueSectionRow>(
    'SELECT id, name, display_order FROM venue_sections WHERE venue_id = $1 ORDER BY display_order ASC',
    [venueId],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, displayOrder: row.display_order }));
}

export async function sectionBelongsToVenue(
  pool: Pool,
  venueId: string,
  sectionId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM venue_sections WHERE id = $1 AND venue_id = $2',
    [sectionId, venueId],
  );
  return rows.length > 0;
}

interface RawVenueSeatRow {
  id: string;
  row: string;
  number: number;
  x: string;
  y: string;
}

/** Static seat geometry for one section (docs/plan.md "Realtid": "Arenakartans geometri"), cacheable at the edge for a long time. */
export async function listSeatGeometryForSection(
  pool: Pool,
  sectionId: string,
): Promise<VenueSeatGeometryRow[]> {
  const { rows } = await pool.query<RawVenueSeatRow>(
    'SELECT id, row, number, x, y FROM venue_seats WHERE section_id = $1 ORDER BY row ASC, number ASC',
    [sectionId],
  );
  // `numeric` columns come back as strings from pg (no precision loss
  // on parse) — geometry is a plain display coordinate, not money, so
  // converting to `number` here is safe and matches what the frontend
  // needs to position a seat on a canvas.
  return rows.map((row) => ({
    id: row.id,
    row: row.row,
    number: row.number,
    x: Number(row.x),
    y: Number(row.y),
  }));
}
