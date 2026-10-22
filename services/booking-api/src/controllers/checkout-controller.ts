/**
 * Checkout-skapandets HTTP-yta (docs/plan.md "Betalning"). Ligger
 * bakom BÅDE `createRequireQueueToken` (reservationens ägare) OCH
 * `createRequireAuth0User` (vem som betalar) — `request.queueAuth` och
 * `request.auth0User` är redan satta när denna handler körs (routes/
 * checkout.ts).
 */
import { ValidationError } from '@tickets/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readIdempotencyKey } from './reservations-controller.js';
import { createCheckout, type CheckoutServiceDeps } from '../services/checkout-service.js';

// Återexporterad åt routes/checkout.ts — se queue-controller.ts:s
// motsvarande kommentar.
export type { CheckoutServiceDeps };

const checkoutRouteParamsSchema = z
  .object({ eventId: z.string().uuid(), reservationId: z.string().uuid() })
  .strict();

export function createCreateCheckoutHandler(deps: CheckoutServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const paramsResult = checkoutRouteParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      throw new ValidationError('route params are not valid UUIDs', {
        issues: paramsResult.error.issues,
      });
    }
    const { queueAuth, auth0User } = request;
    if (queueAuth === undefined || auth0User === undefined) {
      throw new ValidationError('missing queue or Auth0 authentication context');
    }

    const result = await createCheckout(deps, {
      eventId: paramsResult.data.eventId,
      reservationId: paramsResult.data.reservationId,
      queueTokenId: queueAuth.queueTokenId,
      idempotencyKey: readIdempotencyKey(request),
      auth0Sub: auth0User.auth0Sub,
      email: auth0User.email,
      name: auth0User.name,
    });
    reply.code(201).send(result);
  };
}
