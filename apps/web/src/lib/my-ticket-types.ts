/** Formen på `GET /me/tickets` (återexporteras från api-client.ts). */

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
