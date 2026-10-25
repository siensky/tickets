/**
 * Thin typed fetch wrapper for booking-api (docs/plan.md "Klienter").
 * No retry/caching logic here — TanStack Query already owns that
 * (docs/forsvar.md "Varför TanStack Query istället för egen polling?").
 * This only knows how to shape one request and parse one response.
 */

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
  readonly venueId: string;
  readonly venueName: string;
  readonly venueCity: string;
  readonly startsAt: string;
  readonly salesOpenAt: string;
  readonly salesCloseAt: string;
  readonly status: string;
  readonly isBeforeOpen: boolean;
  readonly isAfterClose: boolean;
}

export function listEvents(): Promise<{ events: EventSummary[] }> {
  return request('/events');
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

export interface ReservationView {
  readonly reservationId: string;
  readonly eventId: string;
  readonly queueTokenId: string;
  readonly status: 'active' | 'pending_payment' | 'converted' | 'expired' | 'cancelled';
  readonly expiresAt: string;
  readonly seatIds: readonly string[];
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

export interface MyTicket {
  readonly ticketId: string;
  readonly seatId: string;
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
  readonly status: string;
  readonly qrToken: string;
}

export interface MyTicketOrder {
  readonly orderId: string;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly status: string;
  readonly totalCents: number;
  readonly createdAt: string;
  readonly tickets: readonly MyTicket[];
}

export function listMyTickets(accessToken: string): Promise<{ orders: MyTicketOrder[] }> {
  return request('/me/tickets', { headers: { authorization: `Bearer ${accessToken}` } });
}
