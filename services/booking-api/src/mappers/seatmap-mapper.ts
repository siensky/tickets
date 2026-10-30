/**
 * Database-row ↔ API-object conversion for the seat-status cache
 * (docs/rules.md §1). `parseCachedSeatStatuses` narrows the cached JSON
 * string back to `SeatStatusEntry[]` with `as` — allowed here per
 * docs/rules.md §2 because the shape was written by `toSeatStatusEntries`
 * itself a couple of seconds earlier (same contract as
 * reservation-mapper.ts's `parseReplayedReservationResult`).
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
  }));
}

export function parseCachedSeatStatuses(cached: string): SeatStatusEntry[] | undefined {
  const entries = JSON.parse(cached) as SeatStatusEntry[];
  // En post skriven av en äldre podd under en rullande deploy saknar priceCents: räkna som cachemiss.
  return entries.every((entry) => typeof entry.priceCents === 'number') ? entries : undefined;
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
