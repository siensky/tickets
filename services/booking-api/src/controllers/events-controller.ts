/**
 * Events HTTP-ytor (docs/plan.md "Domän och användarflöde": "Välj
 * evenemang"). Public/anonymous — no queue token or login needed, this
 * happens before anyone joins the waiting room.
 */
import { ValidationError } from '@tickets/domain';
import { eventIdParamSchema, listEventsQuerySchema } from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  getEvent,
  listAllEvents,
  type EventsServiceDeps,
} from '../services/events-service.js';

export type { EventsServiceDeps };

export function createListEventsHandler(deps: EventsServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = listEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError('query params are invalid', { issues: parsed.error.issues });
    }
    const events = await listAllEvents(deps, {
      category: parsed.data.category,
      search: parsed.data.q,
    });
    reply.send({ events });
  };
}

export function createGetEventHandler(deps: EventsServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = eventIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('eventId route param is not a valid UUID', {
        issues: parsed.error.issues,
      });
    }
    const event = await getEvent(deps, parsed.data.eventId);
    reply.send(event);
  };
}
