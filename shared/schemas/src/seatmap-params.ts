/**
 * Shared route-param validation for the venue/event seatmap routes
 * (docs/rules.md §6: Zod i strict mode). Venue geometry
 * (`/venues/:venueId/...`) and per-event seat status
 * (`/events/:eventId/...`) are deliberately separate param shapes — the
 * two live on different tables (`venue_seats` is global, `seats` is
 * sharded by `event_id`), matching docs/plan.md "Databas".
 */
import { z } from 'zod';

export const venueIdParamSchema = z.object({ venueId: z.string().uuid() }).strict();
export type VenueIdParam = z.infer<typeof venueIdParamSchema>;

export const venueSectionParamSchema = z
  .object({ venueId: z.string().uuid(), sectionId: z.string().uuid() })
  .strict();
export type VenueSectionParam = z.infer<typeof venueSectionParamSchema>;

export const eventSectionParamSchema = z
  .object({ eventId: z.string().uuid(), sectionId: z.string().uuid() })
  .strict();
export type EventSectionParam = z.infer<typeof eventSectionParamSchema>;

export const eventSeatParamSchema = z
  .object({ eventId: z.string().uuid(), seatId: z.string().uuid() })
  .strict();
export type EventSeatParam = z.infer<typeof eventSeatParamSchema>;
