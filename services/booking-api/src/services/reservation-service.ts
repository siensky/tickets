/**
 * The reservation transaction (docs/plan.md "Concurrency-kärnan"):
 * all-or-nothing seat locking with lazy expiry and idempotency. No
 * HTTP here — the controller/route lives in controllers/ and routes/.
 * Deliberately NO outbox write: nothing consumes a "reservation created"
 * event (docs/plan.md "Idempotens": the outbox carries payment and order
 * events), and the extra INSERT would sit inside the hottest transaction.
 *
 * The idempotency claim/complete calls run OUTSIDE the seat-locking
 * transaction, on their own connection — see
 * repositories/idempotency-repository.ts for why that's required for
 * concurrent retries to actually observe `in_flight`.
 */
import {
  getGlobalPool,
  getPoolForEvent,
  isDeadlockDetected,
  isLockNotAvailable,
  isUniqueViolation,
  withTransaction,
  type ShardPools,
} from '@tickets/db';
import {
  ActiveReservationExistsError,
  IdempotencyConflictError,
  NotFoundError,
  SeatUnavailableError,
} from '@tickets/domain';
import type { Pool, PoolClient } from 'pg';
import { getReservationConfig } from '../repositories/config-repository.js';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  deleteIdempotencyKey,
} from '../repositories/idempotency-repository.js';
import { getSectionNames } from '../repositories/venues-repository.js';
import {
  attachSeatsToReservation,
  cancelActiveReservationForQueueToken,
  getReservationSeatDetails,
  getReservationWithSeats,
  insertReservation,
  lockSeats,
  releaseExpiredSeatsAmong,
} from '../repositories/reservation-repository.js';
import {
  parseReplayedReservationResult,
  toReservationResult,
  toReservationView,
} from '../mappers/reservation-mapper.js';
import { sumSeatPrices } from './pricing.js';
import { computeRequestHash } from './request-hash.js';
import { findUnavailableSeatIds, validateSeatCount } from './seat-availability.js';
import type {
  ReservationConfig,
  ReservationResult,
  ReservationView,
  ReserveSeatsInput,
} from '../types/reservation.js';

const CANCEL_ATTEMPTS = 3;
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_QUEUE_TOKEN_CONSTRAINT = 'reservations_active_queue_token_unique';
// Idempotency keys are scoped to (event, principal, operation) per
// docs/plan.md "Idempotens" — the DB only has (event_id, scope, key),
// so "operation" is folded into `scope` here. Without it, Fas 3 adding
// a payment operation against the same queue token on the same table
// could collide with a reservation attempt that happened to reuse the
// same raw key string.
const IDEMPOTENCY_SCOPE_PREFIX = 'reservation';

export async function reserveSeats(
  shardPools: ShardPools,
  input: ReserveSeatsInput,
): Promise<ReservationResult> {
  const config = await getReservationConfig(getGlobalPool(shardPools));
  validateSeatCount(input.seatIds, config.maxSeatsPerReservation);

  const pool = getPoolForEvent(shardPools, input.eventId);
  const idempotencyScope = {
    eventId: input.eventId,
    scope: `${IDEMPOTENCY_SCOPE_PREFIX}:${input.queueTokenId}`,
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

  let result: ReservationResult;
  try {
    result = await withTransaction(pool, (client) => createReservation(client, input, config));
  } catch (error) {
    // The real work never committed — safe to forget we ever claimed
    // this key, so a retry (same or different seats, availability
    // changes over time) starts fresh instead of being stuck replaying
    // a failure forever.
    await deleteIdempotencyKey(pool, idempotencyScope);
    throw translateReservationError(error, input);
  }

  // The reservation is ALREADY COMMITTED at this point. A failure here
  // must never delete the claim — that would turn a real success into
  // an unrecoverable 500-plus-orphaned-reservation (the client's retry
  // would collide on reservations_active_queue_token_unique and get a
  // 409 that can never surface the reservation they actually got).
  // completeIdempotencyKey is a single idempotent UPDATE, so a few
  // retries on a transient blip is safe and fixes the common case.
  await completeIdempotencyKeyWithRetries(pool, idempotencyScope, result);
  return result;
}

/**
 * `DELETE /reservations/:id`: användaren avbryter sin bokning (bakåtpil/"Avbryt"). Idempotent och
 * begränsad till den anropande kötokenens egen aktiva reservation med just det id:t; en reservation i
 * betalning (`pending_payment`) eller redan köpt lämnas orörd. Lås som inte går att ta direkt (en
 * samtidig reservation/utgång på samma stolar) försöks om några gånger, sedan ett 409 klienten kan upprepa.
 */
export async function cancelReservation(
  shardPools: ShardPools,
  eventId: string,
  reservationId: string,
  queueTokenId: string,
): Promise<void> {
  const pool = getPoolForEvent(shardPools, eventId);
  for (let attempt = 1; attempt <= CANCEL_ATTEMPTS; attempt++) {
    try {
      await withTransaction(pool, (client) =>
        cancelActiveReservationForQueueToken(client, eventId, queueTokenId, reservationId),
      );
      return;
    } catch (error) {
      if (!isLockNotAvailable(error) && !isDeadlockDetected(error)) {
        throw error;
      }
      if (attempt === CANCEL_ATTEMPTS) {
        throw new SeatUnavailableError([]);
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * `GET /reservations/:id` (docs/plan.md "Realtid": läsbart tillstånd
 * klienten kan läsa om vid återanslutning). Scopas på den ANROPANDE
 * kötokenen, aldrig bara på `reservationId` (docs/rules.md §6: IDOR) —
 * annars kunde vem som helst som gissar ett UUID se en annan sessions
 * stolsval. `NotFoundError`, inte `ForbiddenError`, på en mismatch: att
 * avslöja att ID:t EXISTERAR men "är inte ditt" läcker mer än att bara
 * säga "finns inte".
 */
export async function getReservationForQueueToken(
  shardPools: ShardPools,
  eventId: string,
  reservationId: string,
  callerQueueTokenId: string,
): Promise<ReservationView> {
  const pool = getPoolForEvent(shardPools, eventId);
  const row = await getReservationWithSeats(pool, eventId, reservationId);
  if (row === undefined || row.queueTokenId !== callerQueueTokenId) {
    throw new NotFoundError(`Reservation ${reservationId} not found`, { reservationId });
  }
  const seatDetails = await getReservationSeatDetails(pool, eventId, reservationId);
  const sections = await getSectionNames(getGlobalPool(shardPools), [
    ...new Set(seatDetails.map((seat) => seat.sectionId)),
  ]);
  const displayOrder = (sectionId: string): number =>
    sections.get(sectionId)?.displayOrder ?? 0;
  const seats = [...seatDetails]
    .sort(
      (a, b) =>
        displayOrder(a.sectionId) - displayOrder(b.sectionId) ||
        a.row.localeCompare(b.row, 'sv', { numeric: true }) ||
        a.number - b.number,
    )
    .map((seat) => ({ ...seat, sectionName: sections.get(seat.sectionId)?.name ?? '' }));
  // Samma funktion som checkout (services/pricing.ts): summan som visas är summan som debiteras.
  return toReservationView(row, seats, sumSeatPrices(seatDetails));
}

async function completeIdempotencyKeyWithRetries(
  pool: Pool,
  idempotencyScope: { eventId: string; scope: string; key: string },
  result: ReservationResult,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await completeIdempotencyKey(pool, { ...idempotencyScope, responseBody: result });
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

function translateReservationError(error: unknown, input: ReserveSeatsInput): unknown {
  if (isUniqueViolation(error, ACTIVE_QUEUE_TOKEN_CONSTRAINT)) {
    return new ActiveReservationExistsError(input.queueTokenId);
  }
  if (isLockNotAvailable(error) || isDeadlockDetected(error)) {
    // Both are operational "couldn't get your seats right now, retry"
    // outcomes from the caller's point of view — a real Postgres
    // deadlock (40P01) should no longer be reachable from this code
    // path (see releaseExpiredSeatsAmong's header comment), but it's
    // handled the same way as a NOWAIT conflict defensively rather
    // than surfacing as an unmapped 500 + page.
    return new SeatUnavailableError(input.seatIds);
  }
  return error;
}

async function createReservation(
  client: PoolClient,
  input: ReserveSeatsInput,
  config: ReservationConfig,
): Promise<ReservationResult> {
  // En ny reservation ersätter kötokenens egen övergivna (eller utgångna men ännu inte städade) aktiva
  // reservation. Annars låser den gamla, osynliga reservationen ute användaren tills städjobbet hunnit
  // släppa den. En reservation i betalning (`pending_payment`) rörs inte: indexet ger då fortfarande 409.
  await cancelActiveReservationForQueueToken(client, input.eventId, input.queueTokenId);
  const { locked, lockFailedSeatIds } = await lockSeats(client, input.eventId, input.seatIds);

  const foundIds = new Set(locked.map((row) => row.seatId));
  const missing = input.seatIds.filter(
    (id) => !foundIds.has(id) && !lockFailedSeatIds.includes(id),
  );
  if (missing.length > 0) {
    throw new NotFoundError(`Seat(s) not found: ${missing.join(', ')}`, { seatIds: missing });
  }

  const releasedSeatIds = await releaseExpiredSeatsAmong(
    client,
    input.eventId,
    locked.map((row) => row.seatId),
  );
  const unavailable = [
    ...lockFailedSeatIds,
    ...findUnavailableSeatIds(locked, releasedSeatIds),
  ];
  if (unavailable.length > 0) {
    throw new SeatUnavailableError(unavailable);
  }

  const reservation = await insertReservation(client, {
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    holdMinutes: config.holdMinutes,
    jitterMaxSeconds: config.releaseJitterMaxSeconds,
  });
  await attachSeatsToReservation(client, input.eventId, reservation.id, input.seatIds);

  return toReservationResult({
    reservationId: reservation.id,
    eventId: input.eventId,
    queueTokenId: input.queueTokenId,
    seatIds: input.seatIds,
    expiresAt: reservation.expiresAt,
  });
}
