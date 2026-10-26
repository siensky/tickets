/**
 * WebSocket-anslutningens logik (docs/plan.md "Realtid"): köplats,
 * insläpp, reservationsnedräkning, "din stol togs" — alla
 * fire-and-forget-pushar via den poddgemensamma Redis-prenumerationen
 * (services/ws-subscriber-registry.ts). Klienten läser tillbaka samma
 * tillstånd via `GET /queue/status`/`GET /reservations/:id` i
 * booking-api om ett meddelande missas — den här filen levererar
 * ingenting garanterat.
 *
 * Egen controller (docs/rules.md §1: routes → controllers →
 * services-layer) i stället för att routes/ws.ts anropar
 * services-layer direkt — det enda skälet den här filen ser ut som en
 * REST-controller trots att WS-anslutningen inte har request/response i
 * vanlig mening.
 *
 * Autentiseringen sker EFTER WS-handskakningen, inte före — ett giltigt
 * men obehörigt försök stängs med close-kod 4001 i stället för att
 * avvisas på HTTP-nivå, vilket räcker för en intern, ingen-UI-krävs
 * signal (fas 5 bygger klientens hantering av den).
 *
 * Token skickas i det FÖRSTA WS-meddelandet, aldrig i `/ws?token=...`
 * (docs/rules.md §6: "Aldrig tokens eller hemligheter i loggar eller
 * URL:er", docs/plan.md "Auth") — en query-sträng hamnar rakt i både
 * Fastifys requestloggning och ingress-nginx:s access-loggar.
 */
import { verifyQueueToken, type createQueueTokenSecret } from '@tickets/auth';
import { isQueueTokenRevoked, type RedisClient } from '@tickets/redis';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsSubscriberRegistry } from '../services/ws-subscriber-registry.js';

// Ingress-nginx's proxy-read-timeout är satt till 120 s (infra/terraform/
// helm.tf) med marginal utöver planens "~30:e sekund" — denna siffra
// måste ligga klart under BÅDA, annars kapas idle-anslutningar och
// klienterna hamnar i en återanslutningsstorm som ser ut som ett
// skalningsproblem (docs/plan.md "Realtid").
const HEARTBEAT_INTERVAL_MS = 25_000;
const INVALID_TOKEN_CLOSE_CODE = 4001;
const AUTH_MESSAGE_TIMEOUT_MS = 5_000;

export interface WsRouteDeps {
  readonly redis: RedisClient;
  readonly wsSubscribers: WsSubscriberRegistry;
  readonly queueTokenSecret: ReturnType<typeof createQueueTokenSecret>;
}

function readTokenFromMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const token = (parsed as Record<string, unknown>)['token'];
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Väntar på klientens FÖRSTA meddelande (förväntat `{"token": "..."}`), med ett kort tak så en tyst anslutning inte hålls öppen i onödan. */
function waitForToken(socket: WebSocket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(undefined), AUTH_MESSAGE_TIMEOUT_MS);
    socket.once('message', (raw: unknown) => settle(readTokenFromMessage(raw)));
    socket.once('close', () => settle(undefined));
  });
}

async function authenticateConnection(
  deps: WsRouteDeps,
  token: string,
): Promise<{ queueTokenId: string } | undefined> {
  const verification = await verifyQueueToken(deps.queueTokenSecret, token);
  if (verification.kind === 'invalid') {
    return undefined;
  }
  const revoked = await isQueueTokenRevoked(deps.redis, verification.queueTokenId);
  if (revoked) {
    return undefined;
  }
  return { queueTokenId: verification.queueTokenId };
}

function startHeartbeat(socket: WebSocket): () => void {
  const timer = setInterval(() => {
    if (socket.readyState === socket.OPEN) {
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Exported for tests — calls this directly with a fake socket, instead of driving a real WS upgrade through Fastify. */
export async function handleConnection(
  socket: WebSocket,
  _request: FastifyRequest,
  deps: WsRouteDeps,
): Promise<void> {
  // Registreras INNAN någon `await` — en klient som kopplar ner medan vi
  // väntar på token ska inte kunna läcka en lokal mottagare för alltid.
  // Ett muterat objekt i stället för två `let`-variabler — de sätts bara
  // en gång var, men EFTER att close-hooken redan läser dem.
  const cleanup: {
    stopHeartbeat?: () => void;
    unregister?: () => void;
  } = {};
  socket.on('close', () => {
    cleanup.stopHeartbeat?.();
    cleanup.unregister?.();
  });

  const token = await waitForToken(socket);
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  const auth = token === undefined ? undefined : await authenticateConnection(deps, token);
  if (auth === undefined) {
    socket.close(INVALID_TOKEN_CLOSE_CODE, 'invalid or revoked queue token');
    return;
  }

  // register() är synkront (ingen Redis-anslutning per klient längre,
  // se ws-subscriber-registry.ts) — till skillnad från den tidigare
  // `await subscribeToChannel(...)` finns alltså inget fönster där
  // socketen kan stänga mellan registrering och att den faktiskt gäller.
  cleanup.stopHeartbeat = startHeartbeat(socket);
  cleanup.unregister = deps.wsSubscribers.register(auth.queueTokenId, (payload) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  });
}
