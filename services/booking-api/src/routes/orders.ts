/**
 * Orderstatus-routen (docs/plan.md 7.13 E6). Bakom Auth0, som "mina
 * biljetter". Per-IP-gränsen räcker: frontend pollar var 2:a sekund i max 60 s.
 */
import type { Auth0Verifier } from '@tickets/auth';
import type { FastifyInstance } from 'fastify';
import { createRequireAuth0User } from '../controllers/auth0-controller.js';
import {
  createGetOrderStatusHandler,
  type OrderStatusServiceDeps,
} from '../controllers/orders-controller.js';

export function registerOrderRoutes(
  app: FastifyInstance,
  deps: OrderStatusServiceDeps,
  auth0Verifier: Auth0Verifier,
): void {
  app.get('/events/:eventId/orders/:orderId', {
    preHandler: createRequireAuth0User(auth0Verifier),
    handler: createGetOrderStatusHandler(deps),
  });
}
