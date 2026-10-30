/**
 * Direktinsläpp (docs/plan.md "Väntrum"): är kön tom och gränsen inte nådd släpps en enstaka
 * köpare rakt till kartan utan att se väntrummet. Är gränsen 0 köar alla och släpps in av
 * schemaläggaren. Gränsen återställs till standard (1000) efteråt.
 */
import { expect, test } from '@playwright/test';
import { admitWaiting, setDirectAdmitLimit } from '../helpers/queue.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.keyboard;

test.afterAll(async () => {
  await setDirectAdmitLimit(1000);
});

test('hoppar över väntrummet när kön är tom', async ({ page }) => {
  await setDirectAdmitLimit(1000);
  await page.goto(`/events/${EVENT.id}`);
  await page.getByRole('link', { name: 'Boka biljetter' }).first().click();

  await page.waitForURL(`**/events/${EVENT.id}/seatmap`, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Välj sektion' })).toBeVisible();
});

test('ställer alla i kön när gränsen är 0 och släpper in dem därifrån', async ({ page }) => {
  await setDirectAdmitLimit(0);
  await page.goto(`/events/${EVENT.id}`);
  await page.getByRole('link', { name: 'Boka biljetter' }).first().click();

  await expect(page.getByText(/personer köar/)).toBeVisible({ timeout: 10_000 });
  await admitWaiting(EVENT.id);
  await page.waitForURL(`**/events/${EVENT.id}/seatmap`, { timeout: 15_000 });
});
