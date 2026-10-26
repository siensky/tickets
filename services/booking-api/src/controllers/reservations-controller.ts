/**
 * Reservationens HTTP-ytor (docs/plan.md "Concurrency-kärnan").
 * `POST` ligger bakom `createRequireAdmittedQueueToken` (se routes/
 * reservations.ts) — `request.queueAuth` är redan satt när dessa
 * handlers körs.
 */
import { ValidationError } from '@tickets/domain';
import { createReservationRequestSchema } from '@tickets/schemas';
import type { ShardPools } from '@tickets/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readRequiredHeader } from './http-headers.js';
import { getReservationForQueueToken, reserveSeats } from '../services/reservation-service.js';
import { notifySeatsTaken, type SeatMarkServiceDeps } from '../services/seat-mark-service.js';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const reservationRouteParamsSchema = z
  .object({ eventId: z.string().uuid(), reservationId: z.string().uuid() })
  .strict();

export function readIdempotencyKey(request: FastifyRequest): string {
  return readRequiredHeader(request, IDEMPOTENCY_KEY_HEADER, () => {
    throw new ValidationError('Idempotency-Key header is required');
  });
}

export function createCreateReservationHandler(
  shardPools: ShardPools,
  seatMarkDeps: SeatMarkServiceDeps,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const bodyResult = createReservationRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new ValidationError('Invalid reservation request body', {
        issues: bodyResult.error.issues,
      });
    }
    // Satt av createRequireAdmittedQueueToken — denna route registreras
    // alltid med den preHandlern (routes/reservations.ts), så fältet
    // finns garanterat när vi kommer hit.
    const queueAuth = request.queueAuth;
    if (queueAuth === undefined) {
      throw new ValidationError('missing queue authentication context');
    }

    const result = await reserveSeats(shardPools, {
      eventId: queueAuth.eventId,
      seatIds: bodyResult.data.seatIds,
      queueTokenId: queueAuth.queueTokenId,
      idempotencyKey: readIdempotencyKey(request),
    });
    // Best-effort — docs/plan.md "din stol togs": notifiera alla andra
    // kötoken som hade något av dessa stolar markerat. Får aldrig fälla
    // detta svar, reservationen är redan committad.
    await notifySeatsTaken(seatMarkDeps, {
      eventId: queueAuth.eventId,
      seatIds: result.seatIds,
      takenByQueueTokenId: queueAuth.queueTokenId,
    });
    reply.code(201).send(result);
  };
}

export function createGetReservationHandler(shardPools: ShardPools) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const paramsResult = reservationRouteParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      throw new ValidationError('route params are not valid UUIDs', {
        issues: paramsResult.error.issues,
      });
    }
    const queueAuth = request.queueAuth;
    if (queueAuth === undefined) {
      throw new ValidationError('missing queue authentication context');
    }
    const view = await getReservationForQueueToken(
      shardPools,
      paramsResult.data.eventId,
      paramsResult.data.reservationId,
      queueAuth.queueTokenId,
    );
    reply.send(view);
  };
}
