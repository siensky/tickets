/**
 * End-to-end: välj evenemang → väntrum → arenakarta (sektionsvy) →
 * reservation → RIKTIG Auth0-inloggning (ett dedikerat testkonto, se
 * docs/runbook.md "Nödvändiga GitHub Actions-secrets") → betalning mot
 * payment-mock (aldrig riktiga Stripe) → biljett med QR-kod syns under
 * "Mina biljetter" (docs/plan.md "Domän och användarflöde", fasplan
 * Fas 5: "G: e2e i pipeline").
 *
 * Admission är driven direkt via `admitNextBatch` mot samma Redis den
 * CI-startade booking-api använder, i stället för att köra
 * scheduler-workers periodiska jobb — samma förenkling som
 * services/booking-api/tests/integration/queue-flow.test.ts redan gör,
 * och av samma skäl (dess egen header-kommentar): det här testet
 * bevisar frontend/API-kontraktet, inte timer-schemaläggningen.
 *
 * Auth0-inloggningen automatiserar den RIKTIGA, hostade
 * Universal-Login-sidan (inget mockat) — jag har inte kunnat köra detta
 * steg mot en riktig tenant under utvecklingen, så selektorerna nedan
 * följer Auth0:s dokumenterade standardfält (`name="username"`,
 * `name="password"`, `button[type="submit"]`) men är overifierade tills
 * en riktig CI-körning bekräftar dem.
 */
import { expect, test, type Page } from '@playwright/test';
import { admitNextBatch, createRedisClient } from '@tickets/redis';
import { E2E_EVENT_ID } from '../seed.js';

const APP_ORIGIN = new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

async function admitTheOnlyWaitingToken(): Promise<void> {
  const redis = createRedisClient(process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379');
  try {
    await admitNextBatch(redis, E2E_EVENT_ID, 10, 600);
  } finally {
    await redis.quit();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run this test`);
  }
  return value;
}

/** Fills in Auth0's real hosted Universal Login form and waits for the redirect back. */
async function loginWithTestUser(page: Page): Promise<void> {
  const email = requireEnv('E2E_AUTH0_TEST_USER_EMAIL');
  const password = requireEnv('E2E_AUTH0_TEST_USER_PASSWORD');

  await page.waitForURL((url) => url.origin !== APP_ORIGIN, { timeout: 15_000 });

  const usernameField = page.locator('input[name="username"], input[name="email"]').first();
  await usernameField.waitFor({ state: 'visible', timeout: 15_000 });
  await usernameField.fill(email);

  const passwordField = page.locator('input[name="password"]').first();
  // "Identifier first" tenants show the username alone, then a SEPARATE
  // screen for the password — submit once more if password isn't on
  // the same screen yet.
  if (!(await passwordField.isVisible().catch(() => false))) {
    await page.locator('button[type="submit"]').first().click();
    await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await passwordField.fill(password);
  await page.locator('button[type="submit"]').first().click();

  await page.waitForURL((url) => url.origin === APP_ORIGIN, { timeout: 20_000 });
}

async function reserveOneSeat(page: Page): Promise<void> {
  await page.goto(`/events/${E2E_EVENT_ID}`);
  await expect(page.getByRole('heading', { name: 'E2E Concert' })).toBeVisible();

  // Joining the queue happens async on mount — wait for the waiting-room
  // text instead of a fixed sleep (docs/rules.md §8: "Inga sleep").
  await expect(page.getByText(/Din plats i kön/)).toBeVisible({ timeout: 10_000 });
  await admitTheOnlyWaitingToken();

  const seatmapLink = page.getByRole('link', { name: 'Välj dina platser' });
  await expect(seatmapLink).toBeVisible({ timeout: 10_000 });
  await seatmapLink.click();

  await page.getByRole('button', { name: 'A' }).click();
  await page.getByRole('button', { name: /Rad A, plats 1/ }).click();
  await expect(page.getByText('1 av 5 stolar valda')).toBeVisible();
  await page.getByRole('button', { name: 'Gå vidare' }).click();

  await expect(page.getByRole('heading', { name: 'Din reservation' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('1 stol(ar) reserverade.')).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
}

test('bokar en plats, loggar in och betalar: hela flödet fram till biljetten', async ({
  page,
}) => {
  await reserveOneSeat(page);

  await page.getByRole('button', { name: 'Logga in och betala' }).click();
  await loginWithTestUser(page);

  // Tillbaka på reservationssidan, nu inloggad — knappens text byter
  // (ReservationPage.tsx) när isAuthenticated blir true.
  const payNowButton = page.getByRole('button', { name: 'Gå till betalning' });
  await expect(payNowButton).toBeVisible({ timeout: 10_000 });
  await payNowButton.click();

  // createCheckout lyckas → window.location.href navigerar till
  // payment-mocks checkoutUrl, som inte serverar någon riktig sida (byggd
  // för lasttestets trafik, inte webbläsarbesök) — själva "betalningen"
  // är redan schemalagd server-sidan när sessionen skapades (payment-mock
  // skickar sin webhook automatiskt, se services/payment-mock/src/
  // services/webhook-delivery-service.ts). Väntar bara ut navigeringen,
  // påstår inget om sidan den landar på.
  await page.waitForURL((url) => url.origin !== APP_ORIGIN, { timeout: 10_000 });

  // Auth0-sessionen överlever navigeringen (localStorage-cachad, se
  // apps/web/src/lib/auth-provider.tsx) — ingen ny inloggning behövs.
  await page.goto('/my-tickets');
  await expect(page.getByRole('heading', { name: 'E2E Concert' })).toBeVisible({
    timeout: 20_000, // webhook-leveransen har sin egen latens (PAYMENT_MOCK_LATENCY_MAX_MS)
  });
  await expect(page.getByText('Status: paid')).toBeVisible();
  await expect(page.getByText(/Rad A, plats 1 — valid/)).toBeVisible();
});
