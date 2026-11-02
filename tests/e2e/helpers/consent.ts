/**
 * Samtycke för analytics i e2e (docs/plan.md 7.15). Utan ett sparat val visar appen
 * samtyckesbannern, som skulle täcka t.ex. den sticky bokningsknappen på mobil. Varje spec
 * sätter därför samtycket före sidladdningen; `consent.spec.ts` testar bannern själv.
 */
import type { Page } from '@playwright/test';

export const CONSENT_STORAGE_KEY = 'tikknet:analytics-consent';

export async function setConsent(page: Page, choice: 'granted' | 'denied'): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    CONSENT_STORAGE_KEY,
    choice,
  ] as const);
}
