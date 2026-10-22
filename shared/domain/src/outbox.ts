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
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_REFUNDED: 'order.refunded',
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

/**
 * Payload for `payment.succeeded` — written by the Stripe/payment-mock
 * webhook handler (docs/plan.md "Betalning": "verifiera signatur →
 * dedupe → skriv till outbox → 200 → worker bearbetar"). Deliberately
 * thin: the webhook handler's only job is to prove the charge happened
 * and hand off IDs — the order/ticket transaction itself runs in the
 * consumer, never synchronously in the webhook response path.
 */
export interface PaymentSucceededPayload {
  readonly paymentId: string;
  readonly orderId: string;
  readonly reservationId: string;
  readonly eventId: string;
  readonly providerRef: string;
  readonly providerChargeRef: string;
}

/** Payload for `order.confirmed` — notification-worker's cue to send the confirmation email + QR codes. */
export interface OrderConfirmedPayload {
  readonly orderId: string;
  readonly eventId: string;
  readonly userId: string;
  readonly ticketIds: readonly string[];
}

/**
 * Payload for `order.refunded` — written when a payment lands AFTER its
 * reservation's freeze window already expired and the seats were taken
 * over by someone else (docs/plan.md "Betalning som landar efter
 * utgången reservation": "ett förklarande mejl går ut via
 * notification-worker").
 */
export interface OrderRefundedPayload {
  readonly paymentId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly reservationId: string;
}
