/**
 * Database-row ↔ API-object conversion for the seat-status cache
 * (docs/rules.md §1).
 */
import type {
  CompactSeatStatus,
  SeatCatalog,
  SeatStatus,
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

/** `version` ska stå först: seatmap-service känner igen en cachad katalogs version på svarets början. */
export function toSeatCatalog(rows: readonly SeatStatusRow[], version: string): SeatCatalog {
  return {
    version,
    seats: rows.map((row) => ({
      seatId: row.id,
      venueSeatId: row.venueSeatId,
      priceCents: row.priceCents,
    })),
  };
}

const STATUS_CHAR: Readonly<Record<SeatStatus, string>> = {
  available: 'a',
  held: 'h',
  sold: 's',
};

export function toCompactSeatStatus(
  rows: readonly SeatStatusRow[],
  version: string,
): CompactSeatStatus {
  return {
    version,
    statuses: rows.map((row) => STATUS_CHAR[row.status]).join(''),
    heldUntil: rows.flatMap((row, index) =>
      row.heldUntil === null ? [] : [{ index, until: row.heldUntil.toISOString() }],
    ),
  };
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
