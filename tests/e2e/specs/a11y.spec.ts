/**
 * Tillgänglighet i webbläsaren (docs/plan.md 7.11, 7.15): `@axe-core/playwright` utan
 * `serious`/`critical`-fel på start-, event-, kö-, kart- och checkoutsidan. Till skillnad från
 * enhetstesterna (jsdom) kontrolleras här också färgkontrast, mot den riktiga renderingen.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openSectionA, selectSeat } from '../helpers/booking-steps.js';
import {
  passTheQueue,
  reserveViaApi,
  setDirectAdmitLimit,
  storeQueueToken,
} from '../helpers/queue.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.a11y;

async function expectNoSeriousViolations(page: Page): Promise<void> {
  // Sonner-notisen animeras in (halvtransparent) och ger falska kontrastfel mitt i övergången.
  const results = await new AxeBuilder({ page }).exclude('[data-sonner-toaster]').analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(' | ')})`,
    ),
  ).toEqual([]);
}

test('startsidan', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await expect(page.getByRole('link', { name: /Köp biljetter till/ }).first()).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('eventsidan', async ({ page }) => {
  await page.goto(`/events/${EVENT.id}`);
  await expect(page.getByRole('heading', { level: 1, name: EVENT.title })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('kö-, kart- och sektionsvyn', async ({ page }) => {
  // Alla köar, så att kösidan syns (standard är direktinsläpp).
  await setDirectAdmitLimit(0);
  await page.goto(`/events/${EVENT.id}/queue`);
  await expect(page.getByText(/personer köar/)).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousViolations(page);

  await passTheQueue(page, EVENT.id);
  await expect(page.getByRole('button', { name: /^A, \d+ kvar/ })).toBeVisible();
  await expectNoSeriousViolations(page);

  await openSectionA(page);
  await selectSeat(page, 1);
  await expectNoSeriousViolations(page);
});

test('checkoutsidan', async ({ page }) => {
  const { queueToken, reservationId } = await reserveViaApi(
    EVENT.id,
    EVENT.seatIds.slice(2, 3),
  );
  await storeQueueToken(page, EVENT.id, queueToken);
  await page.goto(`/events/${EVENT.id}/reservations/${reservationId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Granska och betala' }),
  ).toBeVisible();
  await expect(page.getByText('Totalt')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test.afterAll(async () => {
  await setDirectAdmitLimit(1000);
});
