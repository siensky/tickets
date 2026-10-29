/**
 * HTTP-klient mot booking-api. Bara publika, dokumenterade routes
 * (docs/plan.md 7.13 och tidigare faser).
 */
import { randomUUID } from 'node:crypto';
import { API_URL } from './env.js';
import { asArray, asRecord, num, str } from './json.js';
import { waitFor } from './wait-for.js';

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly location: string | null;
}

interface RequestOptions {
  readonly token?: string;
  readonly queueToken?: string;
  readonly idempotencyKey?: string;
  readonly body?: unknown;
  readonly baseUrl?: string;
}

export async function call(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.queueToken !== undefined) headers['x-queue-token'] = options.queueToken;
  if (options.idempotencyKey !== undefined)
    headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${options.baseUrl ?? API_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : parseJson(text),
    location: response.headers.get('location'),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Ställer sig i kön och väntar tills scheduler-workern har släppt in kötoken. */
export async function joinAndAdmit(eventId: string): Promise<string> {
  const joined = await call('POST', `/events/${eventId}/queue/join`);
  if (joined.status !== 201) {
    throw new Error(`queue join failed with ${String(joined.status)}`);
  }
  const queueToken = str(asRecord(joined.body), 'token');
  await waitFor('queue token to be admitted', async () => {
    const status = await call('GET', `/events/${eventId}/queue/status`, { queueToken });
    return str(asRecord(status.body), 'status') === 'admitted' ? true : undefined;
  });
  return queueToken;
}

export interface SeatStatus {
  readonly seatId: string;
  readonly status: string;
  readonly priceCents: number;
}

export async function listAvailableSeats(
  eventId: string,
  sectionId: string,
): Promise<SeatStatus[]> {
  const response = await call('GET', `/events/${eventId}/sections/${sectionId}/seats/status`);
  return asArray(asRecord(response.body)['seats'])
    .map(asRecord)
    .map((seat) => ({
      seatId: str(seat, 'seatId'),
      status: str(seat, 'status'),
      priceCents: num(seat, 'priceCents'),
    }))
    .filter((seat) => seat.status === 'available');
}

export async function listSectionIds(eventId: string): Promise<string[]> {
  const response = await call('GET', `/events/${eventId}/sections/summary`);
  return asArray(asRecord(response.body)['sections']).map((section) =>
    str(asRecord(section), 'id'),
  );
}

export function reserve(
  eventId: string,
  queueToken: string,
  seatIds: readonly string[],
): Promise<ApiResponse> {
  return call('POST', `/events/${eventId}/reservations`, {
    queueToken,
    idempotencyKey: randomUUID(),
    body: { seatIds },
  });
}

export function checkout(
  eventId: string,
  reservationId: string,
  queueToken: string,
  token: string,
): Promise<ApiResponse> {
  return call('POST', `/events/${eventId}/reservations/${reservationId}/checkout`, {
    token,
    queueToken,
    idempotencyKey: randomUUID(),
  });
}

/** Köper `count` stolar hela vägen till en betald order. Returnerar id:n för verifiering. */
export async function purchaseSeats(
  eventId: string,
  token: string,
  count: number,
): Promise<{ orderId: string; reservationId: string; seatIds: string[]; queueToken: string }> {
  const [sectionId] = await listSectionIds(eventId);
  if (sectionId === undefined) throw new Error('event has no sections');
  const queueToken = await joinAndAdmit(eventId);
  const seatIds = (await listAvailableSeats(eventId, sectionId))
    .slice(0, count)
    .map((seat) => seat.seatId);
  const reserved = await reserve(eventId, queueToken, seatIds);
  const reservationId = str(asRecord(reserved.body), 'reservationId');
  const started = await checkout(eventId, reservationId, queueToken, token);
  const { orderId, checkoutUrl } = {
    orderId: str(asRecord(started.body), 'orderId'),
    checkoutUrl: str(asRecord(started.body), 'checkoutUrl'),
  };
  await followCheckoutUrl(checkoutUrl);
  return { orderId, reservationId, seatIds, queueToken };
}

/** Besöker checkoutUrl (payment-mock) och ger success-URL:en den skickar vidare till. */
export async function followCheckoutUrl(checkoutUrl: string): Promise<string> {
  const response = await fetch(checkoutUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null) {
    throw new Error(`Expected 302 from checkoutUrl, got ${String(response.status)}`);
  }
  return location;
}

export async function waitForOrderStatus(
  eventId: string,
  orderId: string,
  token: string,
  expected: string,
): Promise<Record<string, unknown>> {
  return waitFor(`order ${orderId} to become ${expected}`, async () => {
    const response = await call('GET', `/events/${eventId}/orders/${orderId}`, { token });
    const order = asRecord(response.body);
    return response.status === 200 && str(order, 'status') === expected ? order : undefined;
  });
}
