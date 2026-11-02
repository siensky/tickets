/**
 * Tunn typad fetch-wrapper mot booking-api för scannern (docs/plan.md 7.8): eventlistan och
 * `POST /scans`. Ingen cache eller retry: en skanning får aldrig skickas om i smyg.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ScanEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly venueName: string;
  readonly venueCity: string;
}

export type ScanResponse =
  | {
      readonly result: 'ok';
      readonly sectionName: string;
      readonly row: string;
      readonly number: number;
    }
  | { readonly result: 'already_scanned'; readonly scannedAt: string; readonly gate: string }
  | { readonly result: 'not_found' }
  | { readonly result: 'refunded' }
  | { readonly result: 'void' };

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    throw new ApiError(`Request to ${path} failed with ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export async function listEvents(): Promise<readonly ScanEvent[]> {
  const body = await request<{ events: ScanEvent[] }>('/events', { method: 'GET' });
  return body.events;
}

export function postScan(
  accessToken: string,
  body: { eventId: string; qrToken: string; gate: string },
): Promise<ScanResponse> {
  return request<ScanResponse>('/scans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
}
