/**
 * End-to-end: startsida → eventsida → väntrum → arenakarta (översikt → sektionsvy) →
 * bokningspanel → reservation → RIKTIG Auth0-inloggning (ett dedikerat testkonto, se
 * docs/runbook.md "Nödvändiga GitHub Actions-secrets") → betalning mot
 * payment-mock (aldrig riktiga Stripe) → biljett med QR-kod syns under
 * "Mina biljetter" (docs/plan.md "Domän och användarflöde", fasplan
 * Fas 5: "G: e2e i pipeline").
 *
 * Admission är driven direkt via `admitNextBatch` (helpers/queue.ts) mot samma Redis den
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
import { E2E_EVENTS } from '../seed.js';
import { openSectionA, selectSeat } from '../helpers/booking-steps.js';
import { passTheQueue } from '../helpers/queue.js';

const EVENT = E2E_EVENTS.booking;
const APP_ORIGIN = new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

// Forwards browser console/page errors into the CI text log, and dumps
// the visible page text on failure — found live that the uploaded
// artifact (traces/screenshots) was never actually reachable (wrong
// path in e2e.yml, now fixed, but this gives a result in THIS run's
// plain log too, no artifact download needed).
test.beforeEach(({ page }) => {
  page.on('console', (msg) => {
    process.stdout.write(`[browser:${msg.type()}] ${msg.text()}\n`);
  });
  page.on('pageerror', (error) => {
    process.stdout.write(`[pageerror] ${error.message}\n`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '(could not read body)');
    process.stdout.write(`[on-failure] current URL: ${page.url()}\n`);
    process.stdout.write(`[on-failure] visible page text:\n${bodyText}\n`);
  }
});

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
  // Startsida → eventkort → eventsida → "Boka biljetter" → kön.
  await page.goto('/');
  await page
    .getByRole('link', { name: `Köp biljetter till ${EVENT.title}`, exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: EVENT.title })).toBeVisible();
  await page.getByRole('link', { name: 'Boka biljetter' }).first().click();
  await page.waitForURL(`**/events/${EVENT.id}/queue`);

  // Kön ansluts asynkront: väntar på texten i stället för en fast sleep (docs/rules.md §8).
  await passTheQueue(page, EVENT.id);

  // Arenakartan: översikt → sektion A → stol → bokningspanelen.
  await openSectionA(page);
  await selectSeat(page, 1);
  await expect(page.getByText('1/5 valda').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reservera och gå vidare' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Granska och betala' }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('Rad A, plats 1')).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByText('Totalt')).toBeVisible();
}

test('bokar en plats, loggar in och betalar: hela flödet fram till biljetten', async ({
  page,
}) => {
  await reserveOneSeat(page);

  await page.getByRole('button', { name: 'Logga in och betala' }).click();
  await loginWithTestUser(page);

  // Tillbaka på checkoutsidan, nu inloggad — knappens text byter när isAuthenticated blir true.
  const payButton = page.getByRole('button', { name: 'Betala med Stripe' });
  await expect(payButton).toBeVisible({ timeout: 10_000 });
  await payButton.click();

  // createCheckout lyckas → webbläsaren navigerar till payment-mocks checkoutUrl, som svarar med
  // 302 till success_url med event_id och order_id (docs/plan.md 7.13 E6/E8). Betalningen är
  // redan schemalagd server-sidan (payment-mock skickar sin webhook automatiskt).
  await page.waitForURL((url) => url.pathname === '/checkout/success', { timeout: 10_000 });

  // Bekräftelsesidan pollar ordern och visar "klart" först när backend säger `paid`.
  await expect(page.getByRole('heading', { name: 'Tack för ditt köp!' })).toBeVisible({
    timeout: 30_000, // webhook → outbox → RabbitMQ → konsument har sin egen latens
  });

  await page.getByRole('link', { name: 'Visa mina biljetter' }).click();
  await expect(page.getByRole('heading', { name: EVENT.title })).toBeVisible();
  await expect(page.getByText('Betald')).toBeVisible();
  await page.getByRole('button', { name: /Visa QR-kod/ }).click();
  await expect(page.getByRole('img', { name: /QR-kod för/ })).toBeVisible();
});
