/** Bokning på en 375 × 812-skärm (docs/plan.md 7.15): bottenpanelen och "Fortsätt". */
import { expect, test } from '@playwright/test';
import { enterSeatmap, openSectionA, selectSeat } from '../helpers/booking-steps.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.mobile;

test.use({ viewport: { width: 375, height: 812 } });

test('reserverar från bottenpanelen på mobil', async ({ page }) => {
  await enterSeatmap(page, EVENT.id, EVENT.title);
  await openSectionA(page);
  await selectSeat(page, 1);

  const continueButton = page.getByRole('button', { name: 'Fortsätt' });
  await expect(page.getByText(/1 plats · 10\skr/)).toBeVisible();
  await expect(continueButton).toBeInViewport();

  // Pilen expanderar hela sammanfattningen i en bottenpanel.
  await page.getByRole('button', { name: 'Visa sammanfattning' }).click();
  await expect(page.getByRole('dialog').getByText('Preliminär summa')).toBeVisible();
  await page.keyboard.press('Escape');

  await continueButton.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Granska och betala' }),
  ).toBeVisible({
    timeout: 10_000,
  });
});
