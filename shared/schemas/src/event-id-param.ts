/**
 * Shared `:eventId` route-param validation (docs/rules.md §6: Zod i
 * strict mode). Every `/events/:eventId/...` route in every service
 * parses its params through this before touching the shard router —
 * an unvalidated path segment must never reach `hashEventIdToShardIndex`.
 */
import { z } from 'zod';

export const eventIdParamSchema = z.object({ eventId: z.string().uuid() }).strict();

export type EventIdParam = z.infer<typeof eventIdParamSchema>;
