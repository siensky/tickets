/**
 * Köhjälpare för e2e: släpper in väntande kötoken direkt mot samma Redis som booking-api
 * använder (samma förenkling som i `booking-flow`: testet bevisar frontend/API-kontraktet,
 * inte schemaläggarens timer), och låter ett API-konto gå med i kön och reservera stolar.
 */
import { expect, type Page } from '@playwright/test';
import { admitNextBatch, configCacheKey, createRedisClient } from '@tickets/redis';
import { writeConfig } from './config.js';

const API_BASE_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3000';

export async function admitWaiting(eventId: string): Promise<void> {
  const redis = createRedisClient(process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379');
  try {
    await admitNextBatch(redis, eventId, 10, 600, 15);
  } finally {
    await redis.quit();
  }
}

const DIRECT_ADMIT_KEY = 'queue_direct_admit_limit';

/**
 * Sätter direktinsläppsgränsen (0 = alla köar, 1000 = standard) och tömmer booking-apis
 * config-cache i Redis, annars gäller det gamla värdet i upp till 5 s.
 */
export async function setDirectAdmitLimit(limit: number): Promise<void> {
  await writeConfig(DIRECT_ADMIT_KEY, String(limit));
  const redis = createRedisClient(process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379');
  try {
    await redis.del(configCacheKey(DIRECT_ADMIT_KEY));
  } finally {
    await redis.quit();
  }
}

/**
 * Köstart → arenakartan. Standard är direktinsläpp (kön är tom), så sidan går vidare av sig
 * själv. Står sidan i kön (gränsen satt till 0, eller kön full) släpps tokenet in härifrån.
 * Inga sleep: väntar på villkor.
 */
export async function passTheQueue(page: Page, eventId: string): Promise<void> {
  const mapUrl = `**/events/${eventId}/seatmap`;
  await expect
    .poll(
      async () => {
        if (page.url().endsWith(`/events/${eventId}/seatmap`)) {
          return 'map';
        }
        return (await page.getByText(/personer köar/).isVisible()) ? 'queue' : 'loading';
      },
      { timeout: 15_000 },
    )
    .not.toBe('loading');
  if (!page.url().endsWith(`/events/${eventId}/seatmap`)) {
    await admitWaiting(eventId);
  }
  await page.waitForURL(mapUrl, { timeout: 15_000 });
}

async function postJson(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    // Fastify avvisar en tom body med content-type: application/json, så headern sätts bara med body.
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Ett annat "konto": går med i kön, släpps in och reserverar de angivna stolarna. */
export async function reserveViaApi(
  eventId: string,
  seatIds: readonly string[],
): Promise<{ queueToken: string; reservationId: string }> {
  const joined = await postJson(`/events/${eventId}/queue/join`, {});
  expect(joined.status).toBe(201);
  const { token } = (await joined.json()) as { token: string };
  await admitWaiting(eventId);
  const reserved = await postJson(
    `/events/${eventId}/reservations`,
    { 'x-queue-token': token, 'idempotency-key': crypto.randomUUID() },
    { seatIds },
  );
  expect(reserved.status).toBe(201);
  const { reservationId } = (await reserved.json()) as { reservationId: string };
  return { queueToken: token, reservationId };
}

/** Lägger kötoken i webbläsarens localStorage, som appen själv gör vid köanslutning. */
export async function storeQueueToken(
  page: Page,
  eventId: string,
  token: string,
): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `tickets:queue-token:${eventId}`,
    token,
  ] as const);
}
