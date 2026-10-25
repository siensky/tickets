/**
 * Stolmarkeringens routes (docs/plan.md "Realtid": "blå egen
 * markering"). Kräver insläppt kötoken, samma tröskel som
 * reservationsvägen (routes/reservations.ts).
 */
import { isAdmitted } from '@tickets/redis';
import type { FastifyInstance } from 'fastify';
import {
  createRequireAdmittedQueueToken,
  type QueueAuthDeps,
} from '../controllers/queue-controller.js';
import {
  createMarkSeatHandler,
  createUnmarkSeatHandler,
  type SeatMarkServiceDeps,
} from '../controllers/seat-mark-controller.js';

export function registerSeatMarkRoutes(
  app: FastifyInstance,
  deps: QueueAuthDeps & SeatMarkServiceDeps,
): void {
  const requireAdmitted = createRequireAdmittedQueueToken({
    ...deps,
    isAdmitted: (eventId, queueTokenId) => isAdmitted(deps.redis, eventId, queueTokenId),
  });

  app.post('/events/:eventId/seats/:seatId/mark', {
    preHandler: requireAdmitted,
    handler: createMarkSeatHandler(deps),
  });
  app.delete('/events/:eventId/seats/:seatId/mark', {
    preHandler: requireAdmitted,
    handler: createUnmarkSeatHandler(deps),
  });
}
