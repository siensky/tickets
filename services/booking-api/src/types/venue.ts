/**
 * Shapes for the static venue geometry (docs/plan.md "Databas": venues/
 * venue_sections/venue_seats, global shard-0 tables — one venue layout
 * shared across every event at that venue).
 */

export interface VenueRow {
  readonly id: string;
  readonly name: string;
  readonly city: string;
}

export interface VenueSectionRow {
  readonly id: string;
  readonly name: string;
  readonly displayOrder: number;
}

export interface VenueSeatGeometryRow {
  readonly id: string;
  readonly row: string;
  readonly number: number;
  readonly x: number;
  readonly y: number;
}

/** Koordinater i en abstrakt ruta på 0–1000 × 0–700 (SVG-viewBox, docs/plan.md 7.13 E2). */
export interface SectionLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface VenueStage {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `layout` är null för en venue utan layout (t.ex. lasttestarenan). */
export interface VenueSectionWithLayoutRow extends VenueSectionRow {
  readonly layout: SectionLayout | null;
}
