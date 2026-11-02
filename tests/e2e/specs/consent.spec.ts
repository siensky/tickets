/**
 * Samtycke till analytics (docs/plan.md 7.7, 7.15): före samtycke är PostHog cookielöst
 * (minnesbaserat id) och feature-flaggan utvärderas inte; efter "Godkänn" finns PostHogs
 * cookie och flaggan ger "platser kvar"-badgen. Valet kan ändras via "Cookie-inställningar".
 */
import { expect, test, type Page } from '@playwright/test';
import { capturePostHog, POSTHOG_E2E_KEY } from '../helpers/posthog.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.consent;
const POSTHOG_COOKIE = `ph_${POSTHOG_E2E_KEY}_posthog`;
const BANNER = 'Samtycke till statistik';
// Feature-flaggans badge ("3 platser kvar"), inte säljstatusen "Få platser kvar".
const SEATS_LEFT_BADGE = /^\d+ platser kvar$/;

async function postHogStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) =>
      key.startsWith('ph_'),
    ),
  );
}

async function hasPostHogCookie(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  return cookies.some((cookie) => cookie.name === POSTHOG_COOKIE);
}

test('cookielöst före samtycke, cookie och flagga efter "Godkänn"', async ({ page }) => {
  const events = await capturePostHog(page);
  await page.goto(`/events/${EVENT.id}`);
  await expect(page.getByRole('region', { name: BANNER })).toBeVisible();
  await expect.poll(() => events.names(), { timeout: 15_000 }).toContain('event_viewed');
  expect(await hasPostHogCookie(page)).toBe(false);
  expect(await postHogStorageKeys(page)).toEqual([]);

  await page.goto('/');
  await expect(
    page.getByRole('link', { name: `Köp biljetter till ${EVENT.title}` }),
  ).toBeVisible();
  await expect(page.getByText(SEATS_LEFT_BADGE)).toHaveCount(0);

  await page.getByRole('button', { name: 'Godkänn' }).click();
  await expect(page.getByRole('region', { name: BANNER })).toBeHidden();
  await expect.poll(() => hasPostHogCookie(page)).toBe(true);
  await expect(page.getByText(SEATS_LEFT_BADGE).first()).toBeVisible();
});

test('session replay skickar ingenting före samtycke och börjar först efter "Godkänn"', async ({
  page,
}) => {
  const events = await capturePostHog(page);
  await page.goto(`/events/${EVENT.id}`);
  await expect(page.getByRole('region', { name: BANNER })).toBeVisible();
  // Vänta på ett positivt villkor (en senare händelse har skickats) i stället för en fast väntan: då har
  // PostHog hunnit ladda sin konfiguration, och inspelningen hade börjat om den var påslagen.
  await expect.poll(() => events.names(), { timeout: 15_000 }).toContain('event_viewed');
  expect(events.recordingRequests()).toBe(0);

  await page.getByRole('button', { name: 'Godkänn' }).click();
  // Inspelningen skickar när sidan ändras (navigering ger aktivitet).
  await page.getByRole('link', { name: 'tikknet, startsidan' }).click();
  await expect.poll(() => events.recordingRequests(), { timeout: 20_000 }).toBeGreaterThan(0);
});

test('session replay slutar skicka när samtycket återkallas', async ({ page }) => {
  const events = await capturePostHog(page);
  await page.goto(`/events/${EVENT.id}`);
  await page.getByRole('button', { name: 'Godkänn' }).click();
  await page.getByRole('link', { name: 'tikknet, startsidan' }).click();
  await expect.poll(() => events.recordingRequests(), { timeout: 20_000 }).toBeGreaterThan(0);

  // Återkallat samtycke laddar om sidan (posthog-js startar annars om inspelningen, se analytics.ts): vänta in
  // omladdningen och mät sedan att ingen ny inspelningstrafik skickas trots aktivitet.
  await page.getByRole('button', { name: 'Cookie-inställningar' }).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Avvisa' }).click(),
  ]);
  const viewed = (): number => events.names().filter((name) => name === 'event_viewed').length;
  const before = viewed();
  await page.getByRole('link', { name: 'tikknet, startsidan' }).click();
  await page.getByRole('link', { name: `Köp biljetter till ${EVENT.title}` }).click();
  await expect.poll(viewed, { timeout: 15_000 }).toBeGreaterThan(before);
  const settled = events.recordingRequests();

  await page.getByRole('link', { name: 'tikknet, startsidan' }).click();
  await page.getByRole('link', { name: `Köp biljetter till ${EVENT.title}` }).click();
  await expect.poll(viewed, { timeout: 15_000 }).toBeGreaterThan(before + 1);

  expect(events.recordingRequests()).toBe(settled);
});

test('valet kan ändras via Cookie-inställningar', async ({ page }) => {
  await capturePostHog(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Avvisa' }).click();
  await expect(page.getByRole('region', { name: BANNER })).toBeHidden();

  await page.reload();
  await expect(page.getByRole('region', { name: BANNER })).toBeHidden();

  await page.getByRole('button', { name: 'Cookie-inställningar' }).click();
  await expect(page.getByRole('region', { name: BANNER })).toBeVisible();
  await page.getByRole('button', { name: 'Godkänn' }).click();
  await expect(page.getByRole('region', { name: BANNER })).toBeHidden();
  await expect.poll(() => hasPostHogCookie(page)).toBe(true);
});

test('återkallat samtycke tar bort PostHogs cookie igen', async ({ page }) => {
  await capturePostHog(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Godkänn' }).click();
  await expect.poll(() => hasPostHogCookie(page)).toBe(true);

  await page.getByRole('button', { name: 'Cookie-inställningar' }).click();
  await page.getByRole('button', { name: 'Avvisa' }).click();

  await expect.poll(() => hasPostHogCookie(page)).toBe(false);
});
