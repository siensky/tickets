/**
 * Checkout-routen (docs/plan.md "Betalning"). Bakom BÅDE ett giltigt
 * kötoken (reservationens ägare) och en Auth0-inloggning (vem som
 * betalar) — den enda routen i systemet som kräver båda samtidigt.
 */
import type { Auth0Verifier } from '@tickets/auth';
import type { FastifyInstance } from 'fastify';
import { createRequireAuth0User } from '../controllers/auth0-controller.js';
import {
  createCreateCheckoutHandler,
  type CheckoutServiceDeps,
} from '../controllers/checkout-controller.js';
import {
  createRequireQueueToken,
  type QueueAuthDeps,
} from '../controllers/queue-controller.js';

export function registerCheckoutRoutes(
  app: FastifyInstance,
  deps: CheckoutServiceDeps & QueueAuthDeps,
  auth0Verifier: Auth0Verifier,
): void {
  app.post('/events/:eventId/reservations/:reservationId/checkout', {
    preHandler: [createRequireQueueToken(deps), createRequireAuth0User(auth0Verifier)],
    handler: createCreateCheckoutHandler(deps),
  });
}
