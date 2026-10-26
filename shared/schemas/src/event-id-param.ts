/**
 * Shared `:eventId` route-param validation. Every `/events/:eventId/...`
 * route in every service parses its params through this before
 * touching the shard router — an unvalidated path segment must never
 * reach `hashEventIdToShardIndex`.
 *
 * Deliberately NOT `.strict()`, unlike request bodies (docs/rules.md
 * §6): this schema is used by preHandlers that only want to PLUCK
 * `eventId` out of `request.params`, on routes that often have OTHER
 * path params too (`/events/:eventId/reservations/:reservationId`,
 * `/events/:eventId/seats/:seatId/mark`, the checkout route). Fastify's
 * `request.params` always contains every matched segment, so `.strict()`
 * here rejected every one of those as "eventId route param is not a
 * valid UUID" — the real reason was an unrelated extra key, not an
 * invalid UUID. Found live via the Fas 5 e2e suite: GET
 * `/reservations/:id` (Fas 3) and the checkout route were broken by
 * this from the start, just never exercised at the real HTTP layer
 * before (docs/plan.md Fas 3 "kända luckor": route-level inject tests
 * were already flagged as missing). Request BODIES still validate with
 * `.strict()` elsewhere (e.g. shared/schemas/src/reservation.ts) — mass
 * assignment protection belongs there, not on a route-param pluck.
 */
import { z } from 'zod';

export const eventIdParamSchema = z.object({ eventId: z.string().uuid() });

export type EventIdParam = z.infer<typeof eventIdParamSchema>;
