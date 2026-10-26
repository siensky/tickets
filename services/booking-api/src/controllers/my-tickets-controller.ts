/**
 * "Mina biljetter" HTTP-yta (docs/plan.md). Bakom Auth0 (`request.auth0User`
 * redan satt av `createRequireAuth0User`, se routes/my-tickets.ts) —
 * scopas på den INLOGGADE användarens `auth0Sub`, aldrig på ett
 * query-/route-parametervärde (docs/rules.md §6: IDOR). Formaterar
 * in/ut — användaruppslagningen hör till services-lagret, inte hit
 * (docs/rules.md §1: controllers anropar bara services, aldrig
 * repositories direkt).
 */
import { ValidationError } from '@tickets/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  listMyTicketsForAuth0User,
  type MyTicketsServiceDeps,
} from '../services/my-tickets-service.js';

export type { MyTicketsServiceDeps as MyTicketsControllerDeps };

export function createListMyTicketsHandler(deps: MyTicketsServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth0User = request.auth0User;
    if (auth0User === undefined) {
      throw new ValidationError('missing Auth0 authentication context');
    }
    const orders = await listMyTicketsForAuth0User(deps, auth0User.auth0Sub);
    reply.send({ orders });
  };
}
