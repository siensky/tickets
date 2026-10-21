/**
 * Shared vocabulary for the transactional outbox (docs/plan.md
 * "Idempotens"): the event-type names and payload shapes that both the
 * writer (a service inserting an `outbox` row in its own transaction)
 * and the relay (`scheduler-worker`, publishing unpublished rows to
 * RabbitMQ) need to agree on. The actual `outbox` row SQL stays in each
 * service's own repositories/ — this file only has the shared types.
 */

/** Topic exchange every outbox row is published to; routing key = its `type`. */
export const OUTBOX_EXCHANGE = 'domain-events';

export const OUTBOX_EVENT_TYPES = {
  RESERVATION_CREATED: 'reservation.created',
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

/** Payload for `reservation.created` — written when a reservation succeeds. */
export interface ReservationCreatedPayload {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly seatIds: readonly string[];
  readonly expiresAt: string;
}
