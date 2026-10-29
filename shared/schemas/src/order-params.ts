/**
 * Route-parametrar för `/events/:eventId/orders/:orderId` (docs/plan.md
 * 7.13 E6). `eventId` ingår i URL:en eftersom ordrar är shardade per event.
 */
import { z } from 'zod';

export const eventOrderParamSchema = z.object({
  eventId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export type EventOrderParam = z.infer<typeof eventOrderParamSchema>;
