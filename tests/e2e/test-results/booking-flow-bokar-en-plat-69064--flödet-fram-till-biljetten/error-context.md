# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: booking-flow.spec.ts >> bokar en plats, loggar in och betalar: hela flödet fram till biljetten
- Location: specs/booking-flow.spec.ts:118:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Din reservation' })
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('heading', { name: 'Din reservation' }) with timeout 10000ms
  - waiting for getByRole('heading', { name: 'Din reservation' })

```

```yaml
- navigation:
  - link "Evenemang":
    - /url: /
  - text: "|"
  - link "Mina biljetter":
    - /url: /my-tickets
- alert: Kunde inte hämta reservationen.
```

# Test source

```ts
  11  |  * scheduler-workers periodiska jobb — samma förenkling som
  12  |  * services/booking-api/tests/integration/queue-flow.test.ts redan gör,
  13  |  * och av samma skäl (dess egen header-kommentar): det här testet
  14  |  * bevisar frontend/API-kontraktet, inte timer-schemaläggningen.
  15  |  *
  16  |  * Auth0-inloggningen automatiserar den RIKTIGA, hostade
  17  |  * Universal-Login-sidan (inget mockat) — jag har inte kunnat köra detta
  18  |  * steg mot en riktig tenant under utvecklingen, så selektorerna nedan
  19  |  * följer Auth0:s dokumenterade standardfält (`name="username"`,
  20  |  * `name="password"`, `button[type="submit"]`) men är overifierade tills
  21  |  * en riktig CI-körning bekräftar dem.
  22  |  */
  23  | import { expect, test, type Page } from '@playwright/test';
  24  | import { admitNextBatch, createRedisClient } from '@tickets/redis';
  25  | import { E2E_EVENT_ID } from '../seed.js';
  26  | 
  27  | const APP_ORIGIN = new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;
  28  | 
  29  | // Forwards browser console/page errors into the CI text log, and dumps
  30  | // the visible page text on failure — found live that the uploaded
  31  | // artifact (traces/screenshots) was never actually reachable (wrong
  32  | // path in e2e.yml, now fixed, but this gives a result in THIS run's
  33  | // plain log too, no artifact download needed).
  34  | test.beforeEach(({ page }) => {
  35  |   page.on('console', (msg) => {
  36  |     process.stdout.write(`[browser:${msg.type()}] ${msg.text()}\n`);
  37  |   });
  38  |   page.on('pageerror', (error) => {
  39  |     process.stdout.write(`[pageerror] ${error.message}\n`);
  40  |   });
  41  | });
  42  | 
  43  | test.afterEach(async ({ page }, testInfo) => {
  44  |   if (testInfo.status !== testInfo.expectedStatus) {
  45  |     const bodyText = await page.locator('body').innerText().catch(() => '(could not read body)');
  46  |     process.stdout.write(`[on-failure] current URL: ${page.url()}\n`);
  47  |     process.stdout.write(`[on-failure] visible page text:\n${bodyText}\n`);
  48  |   }
  49  | });
  50  | 
  51  | async function admitTheOnlyWaitingToken(): Promise<void> {
  52  |   const redis = createRedisClient(process.env['E2E_REDIS_URL'] ?? 'redis://localhost:6379');
  53  |   try {
  54  |     await admitNextBatch(redis, E2E_EVENT_ID, 10, 600);
  55  |   } finally {
  56  |     await redis.quit();
  57  |   }
  58  | }
  59  | 
  60  | function requireEnv(name: string): string {
  61  |   const value = process.env[name];
  62  |   if (value === undefined || value === '') {
  63  |     throw new Error(`${name} must be set to run this test`);
  64  |   }
  65  |   return value;
  66  | }
  67  | 
  68  | /** Fills in Auth0's real hosted Universal Login form and waits for the redirect back. */
  69  | async function loginWithTestUser(page: Page): Promise<void> {
  70  |   const email = requireEnv('E2E_AUTH0_TEST_USER_EMAIL');
  71  |   const password = requireEnv('E2E_AUTH0_TEST_USER_PASSWORD');
  72  | 
  73  |   await page.waitForURL((url) => url.origin !== APP_ORIGIN, { timeout: 15_000 });
  74  | 
  75  |   const usernameField = page.locator('input[name="username"], input[name="email"]').first();
  76  |   await usernameField.waitFor({ state: 'visible', timeout: 15_000 });
  77  |   await usernameField.fill(email);
  78  | 
  79  |   const passwordField = page.locator('input[name="password"]').first();
  80  |   // "Identifier first" tenants show the username alone, then a SEPARATE
  81  |   // screen for the password — submit once more if password isn't on
  82  |   // the same screen yet.
  83  |   if (!(await passwordField.isVisible().catch(() => false))) {
  84  |     await page.locator('button[type="submit"]').first().click();
  85  |     await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
  86  |   }
  87  |   await passwordField.fill(password);
  88  |   await page.locator('button[type="submit"]').first().click();
  89  | 
  90  |   await page.waitForURL((url) => url.origin === APP_ORIGIN, { timeout: 20_000 });
  91  | }
  92  | 
  93  | async function reserveOneSeat(page: Page): Promise<void> {
  94  |   await page.goto(`/events/${E2E_EVENT_ID}`);
  95  |   await expect(page.getByRole('heading', { name: 'E2E Concert' })).toBeVisible();
  96  | 
  97  |   // Joining the queue happens async on mount — wait for the waiting-room
  98  |   // text instead of a fixed sleep (docs/rules.md §8: "Inga sleep").
  99  |   await expect(page.getByText(/Din plats i kön/)).toBeVisible({ timeout: 10_000 });
  100 |   await admitTheOnlyWaitingToken();
  101 | 
  102 |   const seatmapLink = page.getByRole('link', { name: 'Välj dina platser' });
  103 |   await expect(seatmapLink).toBeVisible({ timeout: 10_000 });
  104 |   await seatmapLink.click();
  105 | 
  106 |   await page.getByRole('button', { name: 'A' }).click();
  107 |   await page.getByRole('button', { name: /Rad A, plats 1/ }).click();
  108 |   await expect(page.getByText('1 av 5 stolar valda')).toBeVisible();
  109 |   await page.getByRole('button', { name: 'Gå vidare' }).click();
  110 | 
> 111 |   await expect(page.getByRole('heading', { name: 'Din reservation' })).toBeVisible({
      |                                                                        ^ Error: expect(locator).toBeVisible() failed
  112 |     timeout: 10_000,
  113 |   });
  114 |   await expect(page.getByText('1 stol(ar) reserverade.')).toBeVisible();
  115 |   await expect(page.getByRole('timer')).toBeVisible();
  116 | }
  117 | 
  118 | test('bokar en plats, loggar in och betalar: hela flödet fram till biljetten', async ({
  119 |   page,
  120 | }) => {
  121 |   await reserveOneSeat(page);
  122 | 
  123 |   await page.getByRole('button', { name: 'Logga in och betala' }).click();
  124 |   await loginWithTestUser(page);
  125 | 
  126 |   // Tillbaka på reservationssidan, nu inloggad — knappens text byter
  127 |   // (ReservationPage.tsx) när isAuthenticated blir true.
  128 |   const payNowButton = page.getByRole('button', { name: 'Gå till betalning' });
  129 |   await expect(payNowButton).toBeVisible({ timeout: 10_000 });
  130 |   await payNowButton.click();
  131 | 
  132 |   // createCheckout lyckas → window.location.href navigerar till
  133 |   // payment-mocks checkoutUrl, som inte serverar någon riktig sida (byggd
  134 |   // för lasttestets trafik, inte webbläsarbesök) — själva "betalningen"
  135 |   // är redan schemalagd server-sidan när sessionen skapades (payment-mock
  136 |   // skickar sin webhook automatiskt, se services/payment-mock/src/
  137 |   // services/webhook-delivery-service.ts). Väntar bara ut navigeringen,
  138 |   // påstår inget om sidan den landar på.
  139 |   await page.waitForURL((url) => url.origin !== APP_ORIGIN, { timeout: 10_000 });
  140 | 
  141 |   // Auth0-sessionen överlever navigeringen (localStorage-cachad, se
  142 |   // apps/web/src/lib/auth-provider.tsx) — ingen ny inloggning behövs.
  143 |   await page.goto('/my-tickets');
  144 |   await expect(page.getByRole('heading', { name: 'E2E Concert' })).toBeVisible({
  145 |     timeout: 20_000, // webhook-leveransen har sin egen latens (PAYMENT_MOCK_LATENCY_MAX_MS)
  146 |   });
  147 |   await expect(page.getByText('Status: paid')).toBeVisible();
  148 |   await expect(page.getByText(/Rad A, plats 1 — valid/)).toBeVisible();
  149 | });
  150 | 
```