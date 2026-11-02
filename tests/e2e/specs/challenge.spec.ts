/**
 * Botskyddet (docs/plan.md 8.5) hela vägen: med en tröskel på 0 försök per minut räknas varje försök som en
 * signal, så `queue/join` svarar 428 med en riktig proof-of-work-utmaning. Webbappen ska lösa den osynligt och
 * komma in i kön utan att användaren ser något. Tröskeln återställs efteråt (seedens värde, 100000).
 */
import { expect, test } from '@playwright/test';
import { configCacheKey, createRedisClient } from '@tickets/redis';
import { setConsent } from '../helpers/consent.js';
import { writeConfig } from '../helpers/config.js';
import { capturePostHog } from '../helpers/posthog.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.keyboard;
const KEY = 'challenge_ip_attempts_per_minute';

async function setAttemptThreshold(value: number): Promise<void> {
  await writeConfig(KEY, String(value));
  const redis = createRedisClient(process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379');
  try {
    await redis.del(configCacheKey('challenge_bundle'));
  } finally {
    await redis.quit();
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await setConsent(page, 'granted');
  await capturePostHog(page);
});

test.afterAll(async () => {
  await setAttemptThreshold(100_000);
});

test('webbappen löser en proof-of-work-utmaning osynligt och kommer in i kön', async ({
  page,
}) => {
  await setAttemptThreshold(0);
  const joinRequests: Record<string, string>[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/queue/join')) {
      joinRequests.push(request.headers());
    }
  });

  await page.goto(`/events/${EVENT.id}`);
  await page.getByRole('link', { name: 'Boka biljetter' }).first().click();

  await page.waitForURL(`**/events/${EVENT.id}/seatmap`, { timeout: 30_000 });
  expect(joinRequests.length).toBeGreaterThanOrEqual(2);
  expect(joinRequests[0]?.['x-pow-solution']).toBeUndefined();
  expect(joinRequests.at(-1)?.['x-pow-solution']).toBeDefined();
  await expect(page.getByText(/bekräfta att du är en människa/i)).toHaveCount(0);
});
