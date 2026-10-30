/**
 * Database-row ↔ API-object conversion for "mina biljetter"
 * (docs/rules.md §1).
 */
import type {
  MyTicket,
  MyTicketOrder,
  EventTicketInfo,
  OrderRow,
  TicketWithSeatRow,
} from '../types/my-tickets.js';

export function toMyTicket(row: TicketWithSeatRow, sectionName: string): MyTicket {
  return {
    ticketId: row.id,
    seatId: row.seatId,
    sectionId: row.sectionId,
    sectionName,
    row: row.row,
    number: row.number,
    status: row.status,
    qrToken: row.qrToken,
  };
}

export function toMyTicketOrder(
  order: OrderRow,
  event: EventTicketInfo,
  venue: { readonly name: string; readonly city: string },
  tickets: readonly MyTicket[],
): MyTicketOrder {
  return {
    orderId: order.id,
    eventId: order.eventId,
    eventTitle: event.title,
    eventStartsAt: event.startsAt?.toISOString() ?? null,
    venueName: venue.name,
    venueCity: venue.city,
    status: order.status,
    totalCents: order.totalCents,
    createdAt: order.createdAt.toISOString(),
    tickets,
  };
}
