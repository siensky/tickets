/**
 * Thin typed fetch wrapper for booking-api (docs/plan.md "Klienter").
 * No retry/caching logic here — TanStack Query already owns that
 * (docs/forsvar.md "Varför TanStack Query istället för egen polling?").
 * This only knows how to shape one request and parse one response. The
 * request helper lives in http.ts and the seat status (catalog + compact
 * status) in seat-status.ts; both are re-exported so callers and test mocks
 * keep using this one module.
 */

import type { EventCategory } from './categories.js';
import { request } from './http.js';
import type { MyTicketOrder } from './my-ticket-types.js';

export type { MyTicket, MyTicketOrder } from './my-ticket-types.js';
export { ApiError } from './http.js';
export {
  getSectionSeatCatalog,
  getSectionSeatStatus,
  getSectionSeatStatusCompact,
  type SeatStatus,
  type SeatStatusEntry,
} from './seat-status.js';

export interface EventSummary {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly category: EventCategory;
  readonly venueId: string;
  readonly venueName: string;
  readonly venueCity: string;
  readonly startsAt: string;
  readonly salesOpenAt: string;
  readonly salesCloseAt: string;
  readonly status: string;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
  readonly imageUrl: string | null;
  readonly description: string | null;
  readonly featured: boolean;
  readonly minPriceCents: number | null;
  readonly maxPriceCents: number | null;
  readonly availableSeats: number;
  readonly totalSeats: number;
  readonly availability: EventAvailability;
}

export type EventAvailability = 'closed' | 'opens_soon' | 'sold_out' | 'few_left' | 'on_sale';

export interface ListEventsFilter {
  readonly category?: EventCategory;
  readonly q?: string;
}

export function listEvents(
  filter: ListEventsFilter = {},
): Promise<{ events: EventSummary[] }> {
  const params = new URLSearchParams();
  if (filter.category !== undefined) {
    params.set('category', filter.category);
  }
  if (filter.q !== undefined && filter.q.length > 0) {
    params.set('q', filter.q);
  }
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return request(`/events${query}`);
}

export function getEvent(eventId: string): Promise<EventSummary> {
  return request(`/events/${eventId}`);
}

export interface VenueSection {
  readonly id: string;
  readonly name: string;
  readonly displayOrder: number;
}

export function listVenueSections(venueId: string): Promise<{ sections: VenueSection[] }> {
  return request(`/venues/${venueId}/sections`);
}

export interface SectionLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface SectionSummaryEntry {
  readonly id: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly layout: SectionLayout | null;
  readonly availableCount: number;
  readonly totalCount: number;
  readonly minPriceCents: number | null;
  readonly maxPriceCents: number | null;
  readonly availability: 'sold_out' | 'few_left' | 'on_sale';
}

export interface SectionSummary {
  readonly stage: Omit<SectionLayout, 'rotation'> | null;
  readonly sections: readonly SectionSummaryEntry[];
}

export function getSectionSummary(eventId: string): Promise<SectionSummary> {
  // `no-store`: kartan pollar var 10:e sekund och får aldrig serveras ur webbläsarens egen HTTP-cache.
  return request(`/events/${eventId}/sections/summary`, { cache: 'no-store' });
}

export interface SeatGeometry {
  readonly id: string;
  readonly row: string;
  readonly number: number;
  readonly x: number;
  readonly y: number;
}

export function getSectionGeometry(
  venueId: string,
  sectionId: string,
): Promise<{ seats: SeatGeometry[] }> {
  return request(`/venues/${venueId}/sections/${sectionId}/seats`);
}

export interface JoinQueueResult {
  readonly token: string;
  readonly eventId: string;
}

/** `headers` bär botskyddets bevis efter ett 428 (lib/challenge.ts, docs/plan.md 8.5). */
export function joinQueue(
  eventId: string,
  headers: Record<string, string> = {},
): Promise<JoinQueueResult> {
  return request(`/events/${eventId}/queue/join`, { method: 'POST', headers });
}

export type QueueStatusResult =
  | { readonly status: 'waiting'; readonly position: number; readonly queueDepth: number }
  | { readonly status: 'admitted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'sales_closed' }
  | { readonly status: 'sold_out' };

export function getQueueStatus(
  eventId: string,
  queueToken: string,
): Promise<QueueStatusResult> {
  return request(`/events/${eventId}/queue/status`, {
    headers: { 'x-queue-token': queueToken },
  });
}

export interface ReservationResult {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly seatIds: readonly string[];
  readonly status: 'active';
  readonly expiresAt: string;
}

export function createReservation(
  eventId: string,
  queueToken: string,
  seatIds: readonly string[],
  idempotencyKey: string,
): Promise<ReservationResult> {
  return request(`/events/${eventId}/reservations`, {
    method: 'POST',
    body: { seatIds },
    headers: { 'x-queue-token': queueToken, 'idempotency-key': idempotencyKey },
  });
}

/** Avbryter den egna aktiva reservationen och släpper stolarna. Idempotent (204 även när den inte längre är aktiv). */
export function cancelReservation(
  eventId: string,
  reservationId: string,
  queueToken: string,
): Promise<void> {
  return request(`/events/${eventId}/reservations/${reservationId}`, {
    method: 'DELETE',
    headers: { 'x-queue-token': queueToken },
  });
}

export interface ReservationSeat {
  readonly seatId: string;
  readonly sectionId: string;
  readonly sectionName: string;
  readonly row: string;
  readonly number: number;
  readonly priceCents: number;
}

export interface ReservationView {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly status: 'active' | 'pending_payment' | 'converted' | 'expired' | 'cancelled';
  readonly expiresAt: string;
  readonly seatIds: readonly string[];
  readonly seats: readonly ReservationSeat[];
  readonly totalCents: number;
  readonly currency: 'SEK';
}

export function getReservation(
  eventId: string,
  reservationId: string,
  queueToken: string,
): Promise<ReservationView> {
  return request(`/events/${eventId}/reservations/${reservationId}`, {
    headers: { 'x-queue-token': queueToken },
  });
}

export function markSeat(eventId: string, seatId: string, queueToken: string): Promise<void> {
  return request(`/events/${eventId}/seats/${seatId}/mark`, {
    method: 'POST',
    headers: { 'x-queue-token': queueToken },
  });
}

export function unmarkSeat(
  eventId: string,
  seatId: string,
  queueToken: string,
): Promise<void> {
  return request(`/events/${eventId}/seats/${seatId}/mark`, {
    method: 'DELETE',
    headers: { 'x-queue-token': queueToken },
  });
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly checkoutUrl: string;
}

export function createCheckout(
  eventId: string,
  reservationId: string,
  queueToken: string,
  accessToken: string,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  return request(`/events/${eventId}/reservations/${reservationId}/checkout`, {
    method: 'POST',
    headers: {
      'x-queue-token': queueToken,
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': idempotencyKey,
    },
  });
}

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';

export interface OrderView {
  readonly orderId: string;
  readonly eventId: string;
  readonly status: OrderStatus;
  readonly totalCents: number;
  readonly ticketCount: number;
}

export function getOrder(
  eventId: string,
  orderId: string,
  accessToken: string,
): Promise<OrderView> {
  return request(`/events/${eventId}/orders/${orderId}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function listMyTickets(accessToken: string): Promise<{ orders: MyTicketOrder[] }> {
  return request('/me/tickets', { headers: { authorization: `Bearer ${accessToken}` } });
}
