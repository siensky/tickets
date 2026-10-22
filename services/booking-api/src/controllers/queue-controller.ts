/**
 * Köns HTTP-ytor (docs/plan.md "Väntrum"): join, status, och den
 * delade `preHandler` som skyddar reservationsvägen bakom "insläppt".
 * Formaterar in/ut — ingen affärslogik här (docs/rules.md §1).
 */
import { QueueTokenInvalidError, QueueTokenNotAdmittedError } from '@tickets/domain';
import { eventIdParamSchema } from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticateQueueToken, type QueueAuthDeps } from '../services/queue-auth-service.js';
import {
  getQueueStatus,
  joinQueue,
  type QueueServiceDeps,
} from '../services/queue-service.js';

// Återexporterade åt routes/*.ts — routes får bara bero på controllers,
// inte direkt på services-lagret (docs/rules.md §1,
// boundaries/dependencies i eslint.config.js).
export type { QueueAuthDeps, QueueServiceDeps };

const QUEUE_TOKEN_HEADER = 'x-queue-token';

function readQueueToken(request: FastifyRequest): string {
  const header = request.headers[QUEUE_TOKEN_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  if (token === undefined) {
    throw new QueueTokenInvalidError('missing X-Queue-Token header');
  }
  return token;
}

function parseEventIdParam(request: FastifyRequest): string {
  const parsed = eventIdParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new QueueTokenInvalidError('eventId route param is not a valid UUID');
  }
  return parsed.data.eventId;
}

export function createJoinQueueHandler(deps: QueueServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const eventId = parseEventIdParam(request);
    const result = await joinQueue(deps, { eventId });
    reply.code(201).send(result);
  };
}

export function createQueueStatusHandler(deps: QueueServiceDeps & QueueAuthDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const eventId = parseEventIdParam(request);
    const token = readQueueToken(request);
    const auth = await authenticateQueueToken(deps, token);
    if (auth.kind === 'invalid') {
      throw new QueueTokenInvalidError(auth.reason);
    }
    const status = await getQueueStatus(deps, eventId, auth.queueTokenId);
    reply.send(status);
  };
}

async function authenticateAndMatchEvent(
  deps: QueueAuthDeps,
  request: FastifyRequest,
): Promise<{ queueTokenId: string; eventId: string }> {
  const eventId = parseEventIdParam(request);
  const token = readQueueToken(request);
  const auth = await authenticateQueueToken(deps, token);
  if (auth.kind === 'invalid') {
    throw new QueueTokenInvalidError(auth.reason);
  }
  if (auth.eventId !== eventId) {
    throw new QueueTokenInvalidError('queue token was issued for a different event');
  }
  return { queueTokenId: auth.queueTokenId, eventId };
}

/**
 * Skyddar en route bakom ETT GILTIGT kötoken — utan att kräva att det
 * fortfarande är insläppt. Används av allt EFTER att en reservation
 * redan finns (status, betalning): insläppstakens inaktivitetstak styr
 * bara KÖN, inte om en redan beviljad reservation fortfarande gäller
 * (det avgör reservationens egen `expires_at`/`payment_frozen_until` i
 * Postgres) — annars skulle en kund som slutat polla kön men sitter
 * kvar i kassan tappas ut av ett helt orelaterat tak.
 */
export function createRequireQueueToken(deps: QueueAuthDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    request.queueAuth = await authenticateAndMatchEvent(deps, request);
  };
}

/**
 * Skyddar en route bakom ett giltigt OCH insläppt kötoken (docs/plan.md
 * "Concurrency-kärnan": reservationsvägen — den enda åtgärden som
 * faktiskt hoppar kölinjen). Sätter `request.queueAuth` åt den faktiska
 * route-handlern — `declare module 'fastify'` i `routes/
 * request-context.ts` deklarerar fältet.
 */
export function createRequireAdmittedQueueToken(
  deps: QueueAuthDeps & {
    readonly isAdmitted: (eventId: string, queueTokenId: string) => Promise<boolean>;
  },
) {
  return async (request: FastifyRequest): Promise<void> => {
    const { queueTokenId, eventId } = await authenticateAndMatchEvent(deps, request);
    const admitted = await deps.isAdmitted(eventId, queueTokenId);
    if (!admitted) {
      throw new QueueTokenNotAdmittedError(queueTokenId);
    }
    request.queueAuth = { queueTokenId, eventId };
  };
}
