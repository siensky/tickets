/**
 * Stolmarkering HTTP-ytor (docs/plan.md "Realtid": "blå egen
 * markering"). Bakom samma insläppta kötoken som reservationsvägen
 * (routes/seat-marks.ts) — markering är bara meningsfull för någon som
 * faktiskt kan gå vidare till en reservation.
 */
import { ValidationError } from '@tickets/domain';
import { eventSeatParamSchema } from '@tickets/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  markSeat,
  unmarkSeat,
  type SeatMarkServiceDeps,
} from '../services/seat-mark-service.js';

export type { SeatMarkServiceDeps };

function parseEventSeatParams(request: FastifyRequest): { eventId: string; seatId: string } {
  const parsed = eventSeatParamSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('eventId/seatId route params are not valid UUIDs', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function requireQueueAuth(request: FastifyRequest): { queueTokenId: string } {
  const queueAuth = request.queueAuth;
  if (queueAuth === undefined) {
    throw new ValidationError('missing queue authentication context');
  }
  return queueAuth;
}

export function createMarkSeatHandler(deps: SeatMarkServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { eventId, seatId } = parseEventSeatParams(request);
    const { queueTokenId } = requireQueueAuth(request);
    await markSeat(deps, { eventId, queueTokenId, seatId });
    reply.code(204).send();
  };
}

export function createUnmarkSeatHandler(deps: SeatMarkServiceDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { eventId, seatId } = parseEventSeatParams(request);
    const { queueTokenId } = requireQueueAuth(request);
    await unmarkSeat(deps, { eventId, queueTokenId, seatId });
    reply.code(204).send();
  };
}
