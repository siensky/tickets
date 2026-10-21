/**
 * The reservation transaction (docs/plan.md "Concurrency-kärnan"):
 * all-or-nothing seat locking with lazy expiry, idempotency, and a
 * same-transaction outbox write. No HTTP here — Fas 3 adds the
 * controller/route once the real queue token exists; callers for now
 * are the crown-jewel integration tests.
 *
 * The idempotency claim/complete calls run OUTSIDE the seat-locking
 * transaction, on their own connection — see
 * repositories/idempotency-repository.ts for why that's required for
 * concurrent retries to actually observe `in_flight`.
 */
import { getGlobalPool, getPoolForEvent, withTransaction, type ShardPools } from '@tickets/db';
import {
  ActiveReservationExistsError,
  IdempotencyConflictError,
  NotFoundError,
  OUTBOX_EVENT_TYPES,
  SeatUnavailableError,
  type ReservationCreatedPayload,
} from '@tickets/domain';
import type { PoolClient } from 'pg';
import { getReservationConfig } from '../repositories/config-repository.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  deleteIdempotencyKey,
} from '../repositories/idempotency-repository.js';
import { insertOutboxEvent } from '../repositories/outbox-repository.js';
import {
  attachSeatsToReservation,
  expireReservations,
  insertReservation,
  lockSeats,
  releaseSeatsForReservations,
} from '../repositories/reservation-repository.js';
import {
  parseReplayedReservationResult,
  toReservationResult,
} from '../mappers/reservation-mapper.js';
import { isLockNotAvailable, isUniqueViolation } from './pg-error-codes.js';
import { computeRequestHash } from './request-hash.js';
import {
  findHeldReservationIds,
  findUnavailableSeatIds,
  validateSeatCount,
} from './seat-availability.js';
import type {
  ReservationConfig,
  ReservationResult,
  ReserveSeatsInput,
} from '../types/reservation.js';

const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_QUEUE_TOKEN_CONSTRAINT = 'reservations_active_queue_token_unique';

export async function reserveSeats(
  shardPools: ShardPools,
  input: ReserveSeatsInput,
): Promise<ReservationResult> {
  const config = await getReservationConfig(getGlobalPool(shardPools));
  validateSeatCount(input.seatIds, config.maxSeatsPerReservation);

  const pool = getPoolForEvent(shardPools, input.eventId);
  const idempotencyScope = {
    eventId: input.eventId,
    scope: input.queueTokenId,
    key: input.idempotencyKey,
  };
  const requestHash = computeRequestHash(input);

  const claim = await claimIdempotencyKey(pool, {
    ...idempotencyScope,
    requestHash,
    ttlMs: IDEMPOTENCY_KEY_TTL_MS,
  });
  if (claim.kind === 'in_flight' || claim.kind === 'hash_mismatch') {
    // Both map to the same 409 family: docs/plan.md "Idempotens" treats
    // a concurrent retry that arrived before the winner finished the
    // same way as a key reused with a different body — either way, the
    // caller must retry, never get back an empty or wrong response.
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
  if (claim.kind === 'completed') {
    return parseReplayedReservationResult(claim.responseBody);
  }

  try {
    const result = await withTransaction(pool, (client) =>
      createReservation(client, input, config),
    );
    await completeIdempotencyKey(pool, { ...idempotencyScope, responseBody: result });
    return result;
  } catch (error) {
    await deleteIdempotencyKey(pool, idempotencyScope);
    throw translateReservationError(error, input);
  }
}

function translateReservationError(error: unknown, input: ReserveSeatsInput): unknown {
  if (isUniqueViolation(error, ACTIVE_QUEUE_TOKEN_CONSTRAINT)) {
    return new ActiveReservationExistsError(input.queueTokenId);
  }
  if (isLockNotAvailable(error)) {
    return new SeatUnavailableError(input.seatIds);
  }
  return error;
}

async function createReservation(
  client: PoolClient,
  input: ReserveSeatsInput,
  config: ReservationConfig,
): Promise<ReservationResult> {
  const seatRows = await lockSeats(client, input.eventId, input.seatIds);
  if (seatRows.length !== input.seatIds.length) {
    const foundIds = new Set(seatRows.map((row) => row.seatId));
    const missing = input.seatIds.filter((id) => !foundIds.has(id));
    throw new NotFoundError(`Seat(s) not found: ${missing.join(', ')}`, { seatIds: missing });
  }

  const expiredIds = await expireReservations(client, findHeldReservationIds(seatRows));
  await releaseSeatsForReservations(client, expiredIds);

  const unavailable = findUnavailableSeatIds(seatRows, expiredIds);
  if (unavailable.length > 0) {
    throw new SeatUnavailableError(unavailable);
  }

  const reservation = await insertReservation(client, {
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    holdMinutes: config.holdMinutes,
    jitterMaxSeconds: config.releaseJitterMaxSeconds,
  });
  await attachSeatsToReservation(client, reservation.id, input.seatIds);
  await writeReservationCreatedOutboxEvent(client, input, reservation);

  return toReservationResult({
    reservationId: reservation.id,
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    seatIds: input.seatIds,
    expiresAt: reservation.expiresAt,
  });
}

async function writeReservationCreatedOutboxEvent(
  client: PoolClient,
  input: ReserveSeatsInput,
  reservation: { id: string; expiresAt: Date },
): Promise<void> {
  const payload: ReservationCreatedPayload = {
    reservationId: reservation.id,
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    seatIds: input.seatIds,
    expiresAt: reservation.expiresAt.toISOString(),
  };
  await insertOutboxEvent(client, {
    eventId: input.eventId,
    type: OUTBOX_EVENT_TYPES.RESERVATION_CREATED,
    payload,
  });
}
