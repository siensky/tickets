/**
 * Reservationens routes (docs/plan.md "Concurrency-kärnan"). `POST`
 * (hoppa kölinjen) kräver insläppt kötoken; `GET` (läsa status) kräver
 * bara ett giltigt kötoken — se createRequireQueueToken:s kommentar.
 */
import type { ShardPools } from '@tickets/db';
import { isAdmitted } from '@tickets/redis';
import type { FastifyInstance } from 'fastify';
import {
  createRequireAdmittedQueueToken,
  createRequireQueueToken,
  type QueueAuthDeps,
} from '../controllers/queue-controller.js';
import {
  createCreateReservationHandler,
  createGetReservationHandler,
} from '../controllers/reservations-controller.js';

export function registerReservationRoutes(
  app: FastifyInstance,
  deps: QueueAuthDeps & { readonly shardPools: ShardPools },
): void {
  const requireAdmitted = createRequireAdmittedQueueToken({
    ...deps,
    isAdmitted: (eventId, queueTokenId) => isAdmitted(deps.redis, eventId, queueTokenId),
  });
  const requireQueueToken = createRequireQueueToken(deps);

  app.post('/events/:eventId/reservations', {
    preHandler: requireAdmitted,
    handler: createCreateReservationHandler(deps.shardPools, {
      redis: deps.redis,
      logger: deps.logger,
    }),
  });
  app.get('/events/:eventId/reservations/:reservationId', {
    preHandler: requireQueueToken,
    handler: createGetReservationHandler(deps.shardPools),
  });
}
