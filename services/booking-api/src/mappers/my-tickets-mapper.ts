/**
 * Database-row ↔ API-object conversion for "mina biljetter"
 * (docs/rules.md §1).
 */
import type {
  MyTicket,
  MyTicketOrder,
  OrderRow,
  TicketWithSeatRow,
} from '../types/my-tickets.js';

export function toMyTicket(row: TicketWithSeatRow): MyTicket {
  return {
    ticketId: row.id,
    seatId: row.seatId,
    sectionId: row.sectionId,
    row: row.row,
    number: row.number,
    status: row.status,
    qrToken: row.qrToken,
  };
}

export function toMyTicketOrder(
  order: OrderRow,
  eventTitle: string,
  tickets: readonly MyTicket[],
): MyTicketOrder {
  return {
    orderId: order.id,
    eventId: order.eventId,
    eventTitle,
    status: order.status,
    totalCents: order.totalCents,
    createdAt: order.createdAt.toISOString(),
    tickets,
  };
}
