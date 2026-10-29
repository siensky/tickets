/**
 * Orderstatus-vyn för bekräftelsesidan (docs/plan.md 7.13 E6). Skild från
 * `OrderRow` i my-tickets.ts: den bär antalet biljetter och ingen
 * tidsstämpel, eftersom sidan bara pollar tills ordern är `paid`.
 */
export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';

export interface OrderStatusRow {
  readonly id: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  readonly totalCents: number;
  readonly ticketCount: number;
}

export interface OrderStatusView {
  readonly orderId: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  readonly totalCents: number;
  readonly ticketCount: number;
}
