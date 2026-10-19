/**
 * WebSocket endpoint — the single-use-case connections listed in
 * docs/plan.md "Realtid" (queue position, reservation countdown, "din
 * stol togs", AI chat streaming). Fan-out across pods goes through Redis
 * Pub/Sub (docs/forsvar.md "Varför behövs Redis Pub/Sub för WebSockets?"),
 * wired in Fas 3 once @tickets/redis exists. For now this just proves a
 * client can connect.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

export function registerWsRoute(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    socket.on('message', (raw: Buffer) => {
      socket.send(JSON.stringify({ echo: raw.toString() }));
    });
  });
}
