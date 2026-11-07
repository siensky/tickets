/**
 * Shapes for the per-event, per-section seat status (docs/plan.md
 * "Realtid": "Stolarnas status | Polling var 2:a sekund mot
 * Redis-cache"). Deliberately separate from venue geometry
 * (types/venue.ts) — status lives on the sharded `seats` table, keyed
 * by `event_id`, while geometry lives on the global `venue_seats` table
 * and never changes per event.
 */

import type { SectionLayout, VenueStage } from './venue.js';

export type SeatStatus = 'available' | 'held' | 'sold';

export interface SeatStatusRow {
  readonly id: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
  readonly priceCents: number;
  /** Utgångstid för en aktiv reservation på stolen; `null` annars (ledig, såld eller i betalning). */
  readonly heldUntil: Date | null;
}

/**
 * En stol i stolsstatussvaret. Svaret cachas färdigt i Redis under `seatmapStatusKey` (shared/redis):
 * ändras formen här ska nyckelns version (`seatmap:v2`) räknas upp, annars kan en podd under en
 * rullande deploy skicka en äldre podds cachade svar i fel form.
 */
export interface SeatStatusEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
  readonly priceCents: number;
  /** ISO-tid då den aktiva reservationen går ut; `null` när ingen sådan finns. */
  readonly heldUntil: string | null;
}

/**
 * `?view=` på stolsstatusen. `full` (standard) är svaret ovan, oförändrat för äldre klienter. `catalog`
 * och `compact` delar upp det: det som aldrig ändras under en försäljning hämtas en gång, och det som
 * pollas varannan sekund blir ett tecken per stol (docs/loadtest-cpu-plan.md, spike-sale).
 */
export type SeatStatusView = 'full' | 'catalog' | 'compact';

/** En stol i katalogen: det som är fast för eventet. */
export interface SeatCatalogEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly priceCents: number;
}

/**
 * `version` är samma i katalogen och den kompakta statusen så länge sektionens stolar är desamma.
 * Klienten matchar dem på position och hämtar om katalogen om versionerna skiljer sig.
 */
export interface SeatCatalog {
  readonly version: string;
  readonly seats: readonly SeatCatalogEntry[];
}

export interface CompactSeatStatus {
  readonly version: string;
  /** Ett tecken per stol i katalogens ordning: `a` ledig, `h` hållen, `s` såld. */
  readonly statuses: string;
  /** Utgångstid för hållna stolar som har en (samma regel som `heldUntil` ovan), per position. */
  readonly heldUntil: readonly { readonly index: number; readonly until: string }[];
}

/** Aggregat per sektion över ett events stolar (docs/plan.md 7.13 E2). */
export interface SectionSeatAggregateRow {
  readonly sectionId: string;
  readonly availableCount: number;
  readonly totalCount: number;
  readonly minPriceCents: number;
  readonly maxPriceCents: number;
}

export interface SectionSummaryEntry {
  readonly id: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly layout: SectionLayout | null;
  readonly availableCount: number;
  readonly totalCount: number;
  readonly minPriceCents: number;
  readonly maxPriceCents: number;
  readonly availability: 'sold_out' | 'few_left' | 'on_sale';
}

export interface SectionSummary {
  readonly stage: VenueStage | null;
  readonly sections: readonly SectionSummaryEntry[];
}
