/**
 * Ett val och en reservation med bara tangentbordet (docs/plan.md 7.11 "Klart när", 7.15):
 * översiktens sektion, stolen (roving tabindex + piltangenter + mellanslag) och
 * "Reservera och gå vidare" nås och aktiveras utan mus.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { passTheQueue } from '../helpers/queue.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.keyboard;
const MAX_TABS = 80;

/** Tabbar tills målet har fokus, så testet inte beror på exakt tabbordning. */
async function tabUntilFocused(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < MAX_TABS; attempt += 1) {
    await page.keyboard.press('Tab');
    const isFocused = await expect(target)
      .toBeFocused({ timeout: 150 })
      .then(
        () => true,
        () => false,
      );
    if (isFocused) {
      return;
    }
  }
  throw new Error(`Fokus nådde aldrig målet inom ${MAX_TABS} tabbar`);
}

test('väljer en stol och reserverar med bara tangentbordet', async ({ page }) => {
  await page.goto(`/events/${EVENT.id}/queue`);
  await passTheQueue(page, EVENT.id);

  await tabUntilFocused(page, page.getByRole('button', { name: /^A, \d+ kvar/ }));
  await page.keyboard.press('Enter');

  // Ingen stol är vald än: den tabbara stolen är den första. Piltangent flyttar fokus.
  await tabUntilFocused(page, page.getByRole('button', { name: /^Rad A, plats 1,/ }));
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: /^Rad A, plats 2,/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: /Rad A, plats 2, .*vald av dig/ }),
  ).toBeVisible();
  await expect(page.getByText('1/5 valda').first()).toBeVisible();

  await tabUntilFocused(
    page,
    page
      .getByRole('region', { name: 'Din bokning' })
      .getByRole('button', { name: 'Reservera och gå vidare' }),
  );
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Granska och betala' }),
  ).toBeVisible({
    timeout: 10_000,
  });
});
