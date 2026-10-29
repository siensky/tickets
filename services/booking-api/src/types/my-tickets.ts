/**
 * Shapes for "mina biljetter" (docs/plan.md "Databas": "Mina ordrar via
 * scatter-gather" — `orders.user_id` has no FK, orders/tickets are
 * sharded by `event_id`, so a user's purchases are scattered across
 * both shards and merged in the service layer, never queried as one
 * cross-shard join).
 */

export interface OrderRow {
  readonly id: string;
  readonly eventId: string;
  readonly status: string;
  readonly totalCents: number;
  readonly createdAt: Date;
}

/** Eventets tid och arena för biljettkorten (docs/plan.md 7.13 E9). */
export interface EventTicketInfo {
  readonly title: string;
  readonly startsAt: Date | null;
  readonly venueId: string;
}

export interface TicketWithSeatRow {
  readonly id: string;
  readonly orderId: string;
  readonly seatId: string;
  readonly qrToken: string;
  readonly status: string;
  readonly row: string;
  readonly number: number;
  readonly sectionId: string;
}

export interface MyTicket {
  readonly ticketId: string;
  readonly seatId: string;
  readonly sectionId: string;
  readonly sectionName: string;
  readonly row: string;
  readonly number: number;
  readonly status: string;
  readonly qrToken: string;
}

export interface MyTicketOrder {
  readonly orderId: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly eventStartsAt: string | null;
  readonly venueName: string;
  readonly venueCity: string;
  readonly status: string;
  readonly totalCents: number;
  readonly createdAt: string;
  readonly tickets: readonly MyTicket[];
}
