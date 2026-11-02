/**
 * Biljettscannern (docs/plan.md 7.8, 7.15): inloggad personal (RIKTIG Auth0-inloggning, rollen
 * staff) väljer event och grind, kameran är en fejkad ström som visar biljettens QR-kod, första
 * skanningen blir `ok` och den andra `already_scanned`. Biljetten seedas direkt i databasen;
 * köpflödet testas i `booking-flow`.
 */
import { expect, test } from '@playwright/test';
import { loginViaAuth0, requireEnv } from '../helpers/auth0-login.js';
import { useFakeCameraShowing } from '../helpers/fake-camera.js';
import { cleanupScannableTickets, seedScannableTicket } from '../helpers/scan-ticket.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.scanner;
const SCANNER_URL = process.env['E2E_SCANNER_URL'] ?? 'http://localhost:5174';

let userId = '';

test.afterEach(async () => {
  if (userId !== '') {
    await cleanupScannableTickets(EVENT.id, userId);
    userId = '';
  }
});

test('personal skannar en biljett: ok, sedan redan skannad', async ({ page }) => {
  const seatId = EVENT.seatIds[0];
  if (seatId === undefined) {
    throw new Error('E2E-eventet saknar stolar');
  }
  const ticket = await seedScannableTicket(EVENT.id, seatId);
  userId = ticket.userId;
  await useFakeCameraShowing(page, ticket.qrToken);

  await page.goto(SCANNER_URL);
  await page.getByRole('button', { name: 'Logga in' }).click();
  await loginViaAuth0(page, new URL(SCANNER_URL).origin, {
    email: requireEnv('E2E_STAFF_EMAIL'),
    password: requireEnv('E2E_STAFF_PASSWORD'),
  });

  await expect(page.getByRole('heading', { name: 'Välj event och grind' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel('Event').selectOption(EVENT.id);
  await page.getByLabel('Grind').selectOption('Grind B');
  await page.getByRole('button', { name: 'Starta skanning' }).click();

  const valid = page.getByRole('heading', { name: 'Giltig biljett' });
  await expect(valid).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EVENT.title).last()).toBeVisible();
  await expect(page.getByText(/rad A, plats 1/)).toBeVisible();

  // Resultatet visas i 2,5 s; koden hålls kvar framför kameran och skannas om efter 3 s.
  await expect(valid).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Redan skannad' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Redan skannad \d{2}:\d{2} vid Grind B/)).toBeVisible();
});
