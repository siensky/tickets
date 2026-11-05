/**
 * Database-row ↔ API-object conversion for the seat-status cache
 * (docs/rules.md §1).
 */
import type {
  SeatStatusEntry,
  SeatStatusRow,
  SectionSeatAggregateRow,
  SectionSummary,
  SectionSummaryEntry,
} from '../types/seatmap.js';
import type { VenueSectionWithLayoutRow, VenueStage } from '../types/venue.js';

export function toSeatStatusEntries(rows: readonly SeatStatusRow[]): SeatStatusEntry[] {
  return rows.map((row) => ({
    seatId: row.id,
    venueSeatId: row.venueSeatId,
    status: row.status,
    priceCents: row.priceCents,
    heldUntil: row.heldUntil === null ? null : row.heldUntil.toISOString(),
  }));
}

/** Slår ihop sektionens layout (global pool) med dess aggregat (eventets shard). `availability` räknas i servicen. */
export function toSectionSummaryEntry(
  section: VenueSectionWithLayoutRow,
  aggregate: SectionSeatAggregateRow,
  availability: SectionSummaryEntry['availability'],
): SectionSummaryEntry {
  return {
    id: section.id,
    name: section.name,
    displayOrder: section.displayOrder,
    layout: section.layout,
    availableCount: aggregate.availableCount,
    totalCount: aggregate.totalCount,
    minPriceCents: aggregate.minPriceCents,
    maxPriceCents: aggregate.maxPriceCents,
    availability,
  };
}

export function toSectionSummary(
  stage: VenueStage | null,
  sections: readonly SectionSummaryEntry[],
): SectionSummary {
  return { stage, sections };
}
