/**
 * Query-parametrar för `GET /events` (docs/plan.md Fas 6: kategori +
 * fritextsök). Delat mellan backend-validering och frontend-formuläret
 * (docs/forsvar.md "ett schema, tre användningar") — `EVENT_CATEGORIES`
 * är den EN platsen kategorivärdena definieras, navbarens knappar
 * (apps/web) läser samma lista i stället för att hårdkoda en egen.
 *
 * `.strict()`: `request.query` innehåller bara det som faktiskt stod i
 * query-strängen (till skillnad från `request.params`, se
 * event-id-param.ts:s kommentar om varför DEN inte är strict).
 */
import { z } from 'zod';

export const EVENT_CATEGORIES = ['music', 'sports', 'theatre', 'festival'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const listEventsQuerySchema = z
  .object({
    category: z.enum(EVENT_CATEGORIES).optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
