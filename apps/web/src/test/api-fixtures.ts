/**
 * Gemensamma API-svar för sidtesterna. `mockApiResponses` kräver att testfilen har mockat
 * `lib/api-client.js` (alla funktioner som `vi.fn()`).
 */
import { vi } from 'vitest';
import * as api from '../lib/api-client.js';

export const EVENT: api.EventSummary = {
  id: 'e1',
  title: 'Neon Rivers',
  artist: 'Neon Rivers',
  category: 'music',
  venueId: 'v1',
  venueName: 'Arenan',
  venueCity: 'Stockholm',
  startsAt: '2026-11-27T19:00:00Z',
  salesOpenAt: '2026-10-01T08:00:00Z',
  salesCloseAt: '2026-11-27T18:00:00Z',
  status: 'scheduled',
  isBeforeOpen: false,
  isAfterClose: false,
  imageUrl: null,
  description: 'En kväll med synth.',
  featured: true,
  minPriceCents: 39_500,
  maxPriceCents: 89_500,
  availableSeats: 100,
  totalSeats: 500,
  availability: 'on_sale',
};

function mockSeatResponses(): void {
  vi.mocked(api.getSectionGeometry).mockResolvedValue({
    seats: [
      { id: 'vs1', row: 'A', number: 1, x: 1, y: 1 },
      { id: 'vs2', row: 'A', number: 2, x: 2, y: 1 },
      { id: 'vs3', row: 'B', number: 1, x: 1, y: 2 },
    ],
  });
  vi.mocked(api.getSectionSeatStatus).mockResolvedValue({
    seats: [
      { seatId: 'a', venueSeatId: 'vs1', status: 'available', priceCents: 39_500 },
      { seatId: 'b', venueSeatId: 'vs2', status: 'held', priceCents: 39_500 },
      { seatId: 'c', venueSeatId: 'vs3', status: 'sold', priceCents: 39_500 },
    ],
  });
}

function mockEventResponses(): void {
  vi.mocked(api.listEvents).mockResolvedValue({ events: [EVENT] });
  vi.mocked(api.getEvent).mockResolvedValue(EVENT);
  vi.mocked(api.getSectionSummary).mockResolvedValue({
    stage: { x: 300, y: 20, width: 400, height: 60 },
    sections: [
      {
        id: 's1',
        name: 'Golv',
        displayOrder: 1,
        layout: { x: 300, y: 140, width: 400, height: 200, rotation: 0 },
        availableCount: 80,
        totalCount: 200,
        minPriceCents: 39_500,
        maxPriceCents: 39_500,
        availability: 'on_sale',
      },
    ],
  });
}

function mockOrderResponses(): void {
  vi.mocked(api.getReservation).mockResolvedValue({
    reservationId: 'r1',
    eventId: 'e1',
    queueTokenId: 'q1',
    status: 'active',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    seatIds: ['a'],
    seats: [
      {
        seatId: 'a',
        sectionId: 's1',
        sectionName: 'Golv',
        row: 'A',
        number: 1,
        priceCents: 39_500,
      },
    ],
    totalCents: 39_500,
    currency: 'SEK',
  });
  vi.mocked(api.getOrder).mockResolvedValue({
    orderId: 'o1',
    eventId: 'e1',
    status: 'paid',
    totalCents: 39_500,
    ticketCount: 1,
  });
}

function mockTicketResponses(): void {
  vi.mocked(api.listMyTickets).mockResolvedValue({
    orders: [
      {
        orderId: 'o1',
        eventId: 'e1',
        eventTitle: 'Neon Rivers',
        eventStartsAt: EVENT.startsAt,
        venueName: 'Arenan',
        venueCity: 'Stockholm',
        status: 'paid',
        totalCents: 39_500,
        createdAt: '2026-10-02T10:00:00Z',
        tickets: [
          {
            ticketId: 't1',
            seatId: 'a',
            sectionId: 's1',
            sectionName: 'Golv',
            row: 'A',
            number: 1,
            status: 'valid',
            qrToken: 'abc',
          },
        ],
      },
    ],
  });
}

export function mockApiResponses(): void {
  mockSeatResponses();
  mockEventResponses();
  mockOrderResponses();
  mockTicketResponses();
}
