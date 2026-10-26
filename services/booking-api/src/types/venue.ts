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
