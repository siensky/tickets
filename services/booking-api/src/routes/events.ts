/**
 * Events routes (docs/plan.md "Domän och användarflöde": "Välj
 * evenemang"). Public/anonymous, no preHandler — see
 * controllers/events-controller.ts.
 */
import type { FastifyInstance } from 'fastify';
import {
  createGetEventHandler,
  createListEventsHandler,
  type EventsServiceDeps,
} from '../controllers/events-controller.js';

export function registerEventRoutes(app: FastifyInstance, deps: EventsServiceDeps): void {
  app.get('/events', createListEventsHandler(deps));
  app.get('/events/:eventId', createGetEventHandler(deps));
}
