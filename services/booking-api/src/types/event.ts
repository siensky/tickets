/**
 * Shapes shared between the events repository, service, and mapper
 * (docs/plan.md "Domän och användarflöde": "Välj evenemang"). `events`
 * has no FK to `venues` (different shard/database, see the migration's
 * own header comment) — `EventRow` carries only `venueId`, the merge
 * with venue info happens in the service layer.
 */
import type { EventCategory } from '@tickets/schemas';

export interface EventRow {
  readonly id: string;
  readonly venueId: string;
  readonly title: string;
  readonly artist: string;
  readonly category: EventCategory;
  readonly startsAt: Date;
  readonly salesOpenAt: Date;
  readonly salesCloseAt: Date;
  readonly status: string;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
}

export interface EventSummary {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly category: EventCategory;
  readonly venueId: string;
  readonly venueName: string;
  readonly venueCity: string;
  readonly startsAt: string;
  readonly salesOpenAt: string;
  readonly salesCloseAt: string;
  readonly status: string;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
}

/** Filter för "Bläddra per kategori"/sökfältet (docs/plan.md Fas 6). Båda valfria — ingen filtrering ger samma lista som tidigare. */
export interface EventsFilter {
  readonly category?: EventCategory;
  readonly search?: string;
}
