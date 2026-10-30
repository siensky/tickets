/**
 * Thin typed fetch wrapper for booking-api (docs/plan.md "Klienter").
 * No retry/caching logic here — TanStack Query already owns that
 * (docs/forsvar.md "Varför TanStack Query istället för egen polling?").
 * This only knows how to shape one request and parse one response.
 */

import type { EventCategory } from './categories.js';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) {
    return undefined as T;
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = json as ErrorBody | undefined;
    throw new ApiError(
      body?.error?.message ?? `Request to ${path} failed with ${response.status}`,
      response.status,
      body?.error?.code,
    );
  }
  return json as T;
}

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
  return request(`/events/${eventId}/sections/summary`);
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

export type SeatStatus = 'available' | 'held' | 'sold';

export interface SeatStatusEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
  readonly priceCents: number;
}

export function getSectionSeatStatus(
  eventId: string,
  sectionId: string,
): Promise<{ seats: SeatStatusEntry[] }> {
  return request(`/events/${eventId}/sections/${sectionId}/seats/status`);
}

export interface JoinQueueResult {
  readonly token: string;
  readonly eventId: string;
}

export function joinQueue(eventId: string): Promise<JoinQueueResult> {
  return request(`/events/${eventId}/queue/join`, { method: 'POST' });
}

export type QueueStatusResult =
  | { readonly status: 'waiting'; readonly position: number; readonly queueDepth: number }
  | { readonly status: 'admitted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'sales_closed' };

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

export function listMyTickets(accessToken: string): Promise<{ orders: MyTicketOrder[] }> {
  return request('/me/tickets', { headers: { authorization: `Bearer ${accessToken}` } });
}
