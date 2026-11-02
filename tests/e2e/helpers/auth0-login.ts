/**
 * Inloggning via Auth0:s RIKTIGA hostade Universal Login-sida (inget mockat), delad av
 * `booking-flow` och `scanner`. Selektorerna följer Auth0:s dokumenterade standardfält
 * (`name="username"`, `name="password"`, `button[type="submit"]`).
 */
import type { Page } from '@playwright/test';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run this test`);
  }
  return value;
}

/** Fyller i inloggningsformuläret och väntar tills webbläsaren är tillbaka på `appOrigin`. */
export async function loginViaAuth0(
  page: Page,
  appOrigin: string,
  credentials: { email: string; password: string },
): Promise<void> {
  await page.waitForURL((url) => url.origin !== appOrigin, { timeout: 15_000 });

  const usernameField = page.locator('input[name="username"], input[name="email"]').first();
  await usernameField.waitFor({ state: 'visible', timeout: 15_000 });
  await usernameField.fill(credentials.email);

  const passwordField = page.locator('input[name="password"]').first();
  // "Identifier first"-tenants visar användarnamnet ensamt och lösenordet på en SEPARAT
  // skärm: skicka in en gång till om lösenordet inte syns än.
  if (!(await passwordField.isVisible().catch(() => false))) {
    await page.locator('button[type="submit"]').first().click();
    await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await passwordField.fill(credentials.password);
  await page.locator('button[type="submit"]').first().click();

  await page.waitForURL((url) => url.origin === appOrigin, { timeout: 20_000 });
}
