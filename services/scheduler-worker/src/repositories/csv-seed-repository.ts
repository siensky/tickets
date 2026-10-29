/**
 * All SQL för `seed-events-from-csv.ts` (docs/plan.md 7.6). Två uppsättningar
 * skrivningar: arenor/sektioner/stolar i global-poolen (shard 0) och event +
 * eventstolar i den shard eventet hashar till. Idempotent: arenor, sektioner
 * och event uppdateras (så en ändrad text, bild eller layout i CSV:n når fram
 * vid omkörning), medan stolar läggs till men aldrig skrivs över, så ett pris
 * på en stol som redan säljs aldrig ändras tyst.
 *
 * Stolarna skrivs med `unnest` av parallella arrayer: en parameteriserad fråga
 * per tabell i stället för en per rad (arenorna har över 2 000 stolar).
 */
import type { PoolClient } from 'pg';
import type {
  PlannedEvent,
  PlannedSection,
  PlannedVenue,
  PlannedVenueSeat,
} from '../mappers/seed-csv-mapper.js';

export async function upsertVenue(client: PoolClient, venue: PlannedVenue): Promise<void> {
  await client.query(
    `INSERT INTO venues (id, name, city, stage_x, stage_y, stage_width, stage_height)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city,
       stage_x = EXCLUDED.stage_x, stage_y = EXCLUDED.stage_y,
       stage_width = EXCLUDED.stage_width, stage_height = EXCLUDED.stage_height`,
    [
      venue.id,
      venue.name,
      venue.city,
      venue.stage.x,
      venue.stage.y,
      venue.stage.width,
      venue.stage.height,
    ],
  );
}

export async function upsertSections(
  client: PoolClient,
  venueId: string,
  sections: readonly PlannedSection[],
): Promise<void> {
  await client.query(
    `INSERT INTO venue_sections (id, venue_id, name, display_order, layout_x, layout_y,
                                 layout_width, layout_height, layout_rotation)
     SELECT id, $2::uuid, name, display_order, x, y, w, h, rotation
     FROM unnest($1::uuid[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[],
                 $8::numeric[], $9::numeric[])
          AS t(id, name, display_order, x, y, w, h, rotation)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, display_order = EXCLUDED.display_order,
       layout_x = EXCLUDED.layout_x, layout_y = EXCLUDED.layout_y,
       layout_width = EXCLUDED.layout_width, layout_height = EXCLUDED.layout_height,
       layout_rotation = EXCLUDED.layout_rotation`,
    [
      sections.map((s) => s.id),
      venueId,
      sections.map((s) => s.name),
      sections.map((s) => s.displayOrder),
      sections.map((s) => s.layout.x),
      sections.map((s) => s.layout.y),
      sections.map((s) => s.layout.width),
      sections.map((s) => s.layout.height),
      sections.map((s) => s.layout.rotation),
    ],
  );
}

export async function insertVenueSeats(
  client: PoolClient,
  venueId: string,
  seats: readonly PlannedVenueSeat[],
): Promise<void> {
  await client.query(
    `INSERT INTO venue_seats (id, venue_id, section_id, row, number, x, y)
     SELECT id, $2::uuid, section_id, row, number, x, y
     FROM unnest($1::uuid[], $3::uuid[], $4::text[], $5::int[], $6::numeric[], $7::numeric[])
          AS t(id, section_id, row, number, x, y)
     ON CONFLICT (id) DO NOTHING`,
    [
      seats.map((s) => s.id),
      venueId,
      seats.map((s) => s.sectionId),
      seats.map((s) => s.row),
      seats.map((s) => s.number),
      seats.map((s) => s.x),
      seats.map((s) => s.y),
    ],
  );
}

export async function upsertEvent(client: PoolClient, event: PlannedEvent): Promise<void> {
  await client.query(
    `INSERT INTO events (id, venue_id, title, artist, category, starts_at, sales_open_at,
                         sales_close_at, image_url, description, featured)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET venue_id = EXCLUDED.venue_id, title = EXCLUDED.title,
       artist = EXCLUDED.artist, category = EXCLUDED.category, starts_at = EXCLUDED.starts_at,
       sales_open_at = EXCLUDED.sales_open_at, sales_close_at = EXCLUDED.sales_close_at,
       image_url = EXCLUDED.image_url, description = EXCLUDED.description,
       featured = EXCLUDED.featured`,
    [
      event.id,
      event.venueId,
      event.title,
      event.artist,
      event.category,
      event.startsAt,
      event.salesOpenAt,
      event.salesCloseAt,
      event.imageKey,
      event.description,
      event.featured,
    ],
  );
}

/** `event_id` på varje rad (docs/rules.md §4). Redan skapade stolar lämnas orörda. */
export async function insertEventSeats(
  client: PoolClient,
  event: PlannedEvent,
): Promise<void> {
  const { seats } = event;
  await client.query(
    `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
     SELECT id, $2::uuid, venue_seat_id, section_id, row, number, ticket_number, price_cents
     FROM unnest($1::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::int[], $7::text[], $8::int[])
          AS t(id, venue_seat_id, section_id, row, number, ticket_number, price_cents)
     ON CONFLICT (id) DO NOTHING`,
    [
      seats.map((s) => s.id),
      event.id,
      seats.map((s) => s.venueSeatId),
      seats.map((s) => s.sectionId),
      seats.map((s) => s.row),
      seats.map((s) => s.number),
      seats.map((s) => s.ticketNumber),
      seats.map((s) => s.priceCents),
    ],
  );
}
