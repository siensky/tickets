/**
 * Seat marking + "din stol togs" fan-out (docs/plan.md "Realtid": "'Din
 * stol togs' kräver att servern känner till markeringar"). Pure Redis
 * side-effects, never part of the reservation DB transaction
 * (docs/plan.md "WebSocket är en optimering, aldrig enda leveransvägen"
 * — a missed notification here still self-heals on the client's next
 * 2 s seatmap poll, since the seat's real status already changed).
 */
import {
  clearSeatMarkHolders,
  getMarkedSeats,
  getSeatMarkHolders,
  markSeat as markSeatInRedis,
  publishToChannel,
  unmarkSeat as unmarkSeatInRedis,
  wsChannel,
  type RedisClient,
} from '@tickets/redis';
import { ValidationError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';

export interface SeatMarkServiceDeps {
  readonly redis: RedisClient;
  readonly logger: Logger;
}

const SEAT_MARK_TTL_SECONDS = 300;
// docs/plan.md "Max 5 stolar per bokning" — marking is pre-reservation
// UI state, but without the same cap one admitted queue token could
// otherwise fill Redis with an unbounded number of marked-seat sets.
const MAX_MARKED_SEATS_PER_QUEUE_TOKEN = 5;

export async function markSeat(
  deps: SeatMarkServiceDeps,
  params: { eventId: string; queueTokenId: string; seatId: string },
): Promise<void> {
  const alreadyMarked = await getMarkedSeats(deps.redis, params.queueTokenId);
  if (
    !alreadyMarked.includes(params.seatId) &&
    alreadyMarked.length >= MAX_MARKED_SEATS_PER_QUEUE_TOKEN
  ) {
    throw new ValidationError(
      `At most ${MAX_MARKED_SEATS_PER_QUEUE_TOKEN} seats may be marked at once`,
      { queueTokenId: params.queueTokenId, limit: MAX_MARKED_SEATS_PER_QUEUE_TOKEN },
    );
  }
  await markSeatInRedis(
    deps.redis,
    params.eventId,
    params.queueTokenId,
    params.seatId,
    SEAT_MARK_TTL_SECONDS,
  );
}

export async function unmarkSeat(
  deps: SeatMarkServiceDeps,
  params: { eventId: string; queueTokenId: string; seatId: string },
): Promise<void> {
  await unmarkSeatInRedis(deps.redis, params.eventId, params.queueTokenId, params.seatId);
}

/**
 * Called after a reservation successfully locks seats. Best-effort and
 * swallows its own errors — the reservation response it's called from
 * has already succeeded and must not fail because of this.
 */
export async function notifySeatsTaken(
  deps: SeatMarkServiceDeps,
  params: { eventId: string; seatIds: readonly string[]; takenByQueueTokenId: string },
): Promise<void> {
  await Promise.all(
    params.seatIds.map((seatId) =>
      notifyOneSeatTaken(deps, params.eventId, seatId, params.takenByQueueTokenId),
    ),
  );
}

async function notifyOneSeatTaken(
  deps: SeatMarkServiceDeps,
  eventId: string,
  seatId: string,
  takenByQueueTokenId: string,
): Promise<void> {
  try {
    const holders = await getSeatMarkHolders(deps.redis, eventId, seatId);
    const toNotify = holders.filter((holderId) => holderId !== takenByQueueTokenId);
    await Promise.all(
      toNotify.map((holderId) =>
        publishToChannel(deps.redis, wsChannel(holderId), { type: 'seat_taken', seatId }),
      ),
    );
    await clearSeatMarkHolders(deps.redis, eventId, seatId, holders);
  } catch (error) {
    deps.logger.warn(
      { error, eventId, seatId },
      'failed to notify seat-mark holders, ignoring',
    );
  }
}
