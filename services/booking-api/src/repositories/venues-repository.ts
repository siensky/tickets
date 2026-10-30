/**
 * All SQL for `venues`/`venue_sections`/`venue_seats` (docs/plan.md
 * "Databas"). Global, shard-0-only tables — every function here takes
 * the GLOBAL pool (`getGlobalPool`), never a per-event pool.
 */
import type { Pool } from 'pg';
import type {
  VenueRow,
  VenueSeatGeometryRow,
  VenueSectionRow,
  VenueSectionWithLayoutRow,
  VenueStage,
} from '../types/venue.js';

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

interface RawSectionLayoutRow extends RawVenueSectionRow {
  // `numeric` kommer som sträng från pg; null när venuen saknar layout.
  layout_x: string | null;
  layout_y: string | null;
  layout_width: string | null;
  layout_height: string | null;
  layout_rotation: string;
}

/** Sektioner med layout för arenakartans översikt (docs/plan.md 7.13 E2). `layout` är null om någon koordinat saknas. */
export async function listSectionsWithLayout(
  pool: Pool,
  venueId: string,
): Promise<VenueSectionWithLayoutRow[]> {
  const { rows } = await pool.query<RawSectionLayoutRow>(
    `SELECT id, name, display_order, layout_x, layout_y, layout_width, layout_height, layout_rotation
     FROM venue_sections WHERE venue_id = $1 ORDER BY display_order ASC`,
    [venueId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayOrder: row.display_order,
    layout:
      row.layout_x === null ||
      row.layout_y === null ||
      row.layout_width === null ||
      row.layout_height === null
        ? null
        : {
            x: Number(row.layout_x),
            y: Number(row.layout_y),
            width: Number(row.layout_width),
            height: Number(row.layout_height),
            rotation: Number(row.layout_rotation),
          },
  }));
}

export async function getVenueStage(pool: Pool, venueId: string): Promise<VenueStage | null> {
  const { rows } = await pool.query<{
    stage_x: string | null;
    stage_y: string | null;
    stage_width: string | null;
    stage_height: string | null;
  }>('SELECT stage_x, stage_y, stage_width, stage_height FROM venues WHERE id = $1', [
    venueId,
  ]);
  const row = rows[0];
  if (
    row === undefined ||
    row.stage_x === null ||
    row.stage_y === null ||
    row.stage_width === null ||
    row.stage_height === null
  ) {
    return null;
  }
  return {
    x: Number(row.stage_x),
    y: Number(row.stage_y),
    width: Number(row.stage_width),
    height: Number(row.stage_height),
  };
}

/** Sektionsnamn och ordning för ett antal sektioner (reservationens stolslista, docs/plan.md 7.13 E5). */
export async function getSectionNames(
  pool: Pool,
  sectionIds: readonly string[],
): Promise<Map<string, VenueSectionRow>> {
  if (sectionIds.length === 0) {
    return new Map();
  }
  const { rows } = await pool.query<RawVenueSectionRow>(
    'SELECT id, name, display_order FROM venue_sections WHERE id = ANY($1)',
    [sectionIds],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, name: row.name, displayOrder: row.display_order },
    ]),
  );
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
