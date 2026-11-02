/**
 * Reservationen går ut (docs/plan.md 7.15): hålltiden sätts till en minut i `config` och
 * återställs efteråt; checkoutsidan visar modalen "Tiden gick ut" och leder tillbaka till kartan.
 * Körs med en worker (playwright.config.ts) så att den tillfälliga hålltiden inte påverkar andra specar.
 */
import { expect, test } from '@playwright/test';
import { readConfig, writeConfig } from '../helpers/config.js';
import { reserveViaApi, storeQueueToken } from '../helpers/queue.js';
import { setConsent } from '../helpers/consent.js';
import { capturePostHog } from '../helpers/posthog.js';
import { E2E_EVENTS } from '../seed.js';

// Samtycke förvalt (annars täcker bannern sidan); ingen trafik når PostHog (docs/plan.md 7.15).
test.beforeEach(async ({ page }) => {
  await setConsent(page, 'granted');
  await capturePostHog(page);
});

const EVENT = E2E_EVENTS.expiry;
const HOLD_KEY = 'reservation_hold_minutes';
let previousHold: string | undefined;

test.beforeAll(async () => {
  previousHold = await readConfig(HOLD_KEY);
  await writeConfig(HOLD_KEY, '1');
});

test.afterAll(async () => {
  await writeConfig(HOLD_KEY, previousHold);
});

// @slow: väntar på att hållningen (1 minut) går ut och körs i ett eget CI-ben (docs/plan.md 8.1).
test(
  'visar "Tiden gick ut" när reservationen löper ut',
  { tag: '@slow' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const { queueToken, reservationId } = await reserveViaApi(
      EVENT.id,
      EVENT.seatIds.slice(0, 1),
    );
    await storeQueueToken(page, EVENT.id, queueToken);

    await page.goto(`/events/${EVENT.id}/reservations/${reservationId}`);
    await expect(page.getByRole('timer')).toBeVisible();

    const dialog = page.getByRole('dialog', { name: 'Tiden gick ut' });
    await expect(dialog).toBeVisible({ timeout: 100_000 });
    await expect(dialog).toContainText('platserna är släppta');
    await dialog.getByRole('button', { name: 'Välj nya platser' }).click();
    await page.waitForURL(`**/events/${EVENT.id}/seatmap`);
  },
);
