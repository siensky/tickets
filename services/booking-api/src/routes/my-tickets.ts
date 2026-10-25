/**
 * "Mina biljetter"-routen (docs/plan.md). Bakom Auth0 — samma krav som
 * checkout (routes/checkout.ts), ingen kötoken behövs för att se sina
 * egna tidigare köp.
 */
import type { Auth0Verifier } from '@tickets/auth';
import type { FastifyInstance } from 'fastify';
import { createRequireAuth0User } from '../controllers/auth0-controller.js';
import {
  createListMyTicketsHandler,
  type MyTicketsControllerDeps,
} from '../controllers/my-tickets-controller.js';

export function registerMyTicketsRoutes(
  app: FastifyInstance,
  deps: MyTicketsControllerDeps,
  auth0Verifier: Auth0Verifier,
): void {
  app.get('/me/tickets', {
    preHandler: createRequireAuth0User(auth0Verifier),
    handler: createListMyTicketsHandler(deps),
  });
}
