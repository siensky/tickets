/**
 * Orderstatus-ytan (docs/plan.md 7.13 E6). Bakom Auth0 (`request.auth0User`
 * satt av `createRequireAuth0User`), scopad på den inloggade användarens
 * `sub`, aldrig på ett parametervärde (docs/rules.md §6: IDOR).
 */
import { ValidationError } from '@tickets/domain';
import { eventOrderParamSchema } from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  getOrderStatusForAuth0User,
  type OrderStatusServiceDeps,
} from '../services/order-status-service.js';

export type { OrderStatusServiceDeps };

export function createGetOrderStatusHandler(deps: OrderStatusServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const parsed = eventOrderParamSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new ValidationError('eventId/orderId route params are not valid UUIDs', {
        issues: parsed.error.issues,
      });
    }
    const auth0User = request.auth0User;
    if (auth0User === undefined) {
      throw new ValidationError('missing Auth0 authentication context');
    }
    const order = await getOrderStatusForAuth0User(deps, {
      auth0Sub: auth0User.auth0Sub,
      eventId: parsed.data.eventId,
      orderId: parsed.data.orderId,
    });
    reply.send(order);
  };
}
