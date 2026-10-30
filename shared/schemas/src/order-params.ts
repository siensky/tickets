/**
 * Route-parametrar för `/events/:eventId/orders/:orderId` (docs/plan.md
 * 7.13 E6). `eventId` ingår i URL:en eftersom ordrar är shardade per event.
 */
import { z } from 'zod';

/**
 * Order-id:n härleds ur en SHA-256-hash (`deriveOrderId` i booking-api) utan
 * RFC 4122 versions- och variantbitar, så Zods strikta `.uuid()` avvisar de flesta.
 * Formen 8-4-4-4-12 hex räcker: id:t går ändå bara till en parameteriserad fråga.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const eventOrderParamSchema = z.object({
  eventId: z.string().uuid(),
  orderId: z.string().regex(UUID_SHAPE),
});

export type EventOrderParam = z.infer<typeof eventOrderParamSchema>;
