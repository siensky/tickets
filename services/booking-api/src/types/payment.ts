/**
 * Shapes for the checkout → webhook → order/ticket flow (docs/plan.md
 * "Betalning"). Kept here instead of inline, same reasoning as
 * types/reservation.ts.
 */

export interface PaymentConfig {
  readonly paymentFrozenMinutes: number;
}

export interface SeatPriceRow {
  readonly seatId: string;
  readonly priceCents: number;
}

export interface CreateCheckoutInput {
  readonly eventId: string;
  readonly reservationId: string;
  readonly queueTokenId: string;
  readonly idempotencyKey: string;
  readonly auth0Sub: string;
  readonly email: string;
  readonly name: string | undefined;
}

export interface CreateCheckoutResult {
  readonly orderId: string;
  readonly checkoutUrl: string;
}

export interface InsertedOrder {
  readonly id: string;
}

export interface InsertedPayment {
  readonly id: string;
}

export interface OrderForPayment {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly reservationId: string | null;
  readonly totalCents: number;
}

export interface PaymentRow {
  readonly id: string;
  readonly eventId: string;
  readonly orderId: string;
  readonly providerRef: string;
  readonly status: string;
}
