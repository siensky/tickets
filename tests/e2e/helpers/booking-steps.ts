/**
 * Gemensamma steg i bokningsflödet för specarna (docs/plan.md 7.15): alla selektorer är roll-,
 * label- och textbaserade, aldrig CSS-klasser eller struktur.
 */
import { expect, type Page } from '@playwright/test';
import { passTheQueue } from './queue.js';

/** Eventsidan → "Boka biljetter" → kön → arenakartan (översikten). */
export async function enterSeatmap(page: Page, eventId: string, title: string): Promise<void> {
  await page.goto(`/events/${eventId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.getByRole('link', { name: 'Boka biljetter' }).first().click();
  await page.waitForURL(`**/events/${eventId}/queue`);
  await passTheQueue(page, eventId);
}

/** Översikten → sektion A. */
export async function openSectionA(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^A, \d+ kvar/ }).click();
  await expect(page.getByRole('button', { name: /Rad A, plats 1, .*ledig/ })).toBeVisible();
}

export async function selectSeat(page: Page, number: number): Promise<void> {
  await page
    .getByRole('button', { name: new RegExp(`Rad A, plats ${number}, .*ledig`) })
    .click();
}
