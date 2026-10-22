/**
 * Köns routes (docs/plan.md "Väntrum"). `join` kräver inget kötoken —
 * det är precis vad som utfärdas här.
 */
import type { FastifyInstance } from 'fastify';
import {
  createJoinQueueHandler,
  createQueueStatusHandler,
  type QueueAuthDeps,
  type QueueServiceDeps,
} from '../controllers/queue-controller.js';

export function registerQueueRoutes(
  app: FastifyInstance,
  deps: QueueServiceDeps & QueueAuthDeps,
): void {
  app.post('/events/:eventId/queue/join', createJoinQueueHandler(deps));
  app.get('/events/:eventId/queue/status', createQueueStatusHandler(deps));
}
