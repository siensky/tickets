/**
 * Merges an event row with its (separately-fetched, different-database)
 * venue row into the API shape (docs/rules.md §1: mappers do the
 * database-row ↔ API-object conversion, nothing else).
 */
import type { EventRow, EventSummary } from '../types/event.js';
import type { VenueRow } from '../types/venue.js';

export function toEventSummary(row: EventRow, venue: VenueRow): EventSummary {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    venueId: row.venueId,
    venueName: venue.name,
    venueCity: venue.city,
    startsAt: row.startsAt.toISOString(),
    salesOpenAt: row.salesOpenAt.toISOString(),
    salesCloseAt: row.salesCloseAt.toISOString(),
    status: row.status,
    isBeforeOpen: row.isBeforeOpen,
    isAfterClose: row.isAfterClose,
  };
}
