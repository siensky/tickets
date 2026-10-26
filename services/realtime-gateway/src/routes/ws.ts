/**
 * WebSocket-route (docs/plan.md "Realtid"). Ren registrering mot
 * Fastify — se controllers/ws-controller.ts för själva anslutnings-
 * logiken (docs/rules.md §1: routes → controllers → services-layer).
 */
import type { FastifyInstance } from 'fastify';
import { handleConnection, type WsRouteDeps } from '../controllers/ws-controller.js';

export type { WsRouteDeps };

export function registerWsRoute(app: FastifyInstance, deps: WsRouteDeps): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    handleConnection(socket, request, deps).catch((error: unknown) => {
      request.log.error({ error }, 'ws connection handler failed');
      socket.close();
    });
  });
}
