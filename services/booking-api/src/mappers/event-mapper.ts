/**
 * Merges an event row with its (separately-fetched, different-database)
 * venue row into the API shape (docs/rules.md §1: mappers do the
 * database-row ↔ API-object conversion, nothing else).
 */
import type { EventAvailability, EventRow, EventSummary } from '../types/event.js';
import type { VenueRow } from '../types/venue.js';

export function toEventSummary(
  row: EventRow,
  venue: VenueRow,
  assetBaseUrl: string,
  availability: EventAvailability,
): EventSummary {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    category: row.category,
    venueId: row.venueId,
    venueName: venue.name,
    venueCity: venue.city,
    startsAt: row.startsAt.toISOString(),
    salesOpenAt: row.salesOpenAt.toISOString(),
    salesCloseAt: row.salesCloseAt.toISOString(),
    status: row.status,
    isBeforeOpen: row.isBeforeOpen,
    isAfterClose: row.isAfterClose,
    imageUrl: row.imageKey === null ? null : new URL(row.imageKey, assetBaseUrl).toString(),
    description: row.description,
    featured: row.featured,
    minPriceCents: row.minPriceCents,
    maxPriceCents: row.maxPriceCents,
    availableSeats: row.availableSeats,
    totalSeats: row.totalSeats,
    availability,
  };
}
