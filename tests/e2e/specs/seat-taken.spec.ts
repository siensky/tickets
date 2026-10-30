/**
 * En annan klient reserverar samma stol medan den är vald (docs/plan.md 7.15): stolen blir
 * "upptagen", tas ur valet och en notis visas. e2e-stacken kör inte realtime-gateway, så det
 * är stolsstatus-pollingen (2 s) som upptäcker det, inte WebSocket.
 */
import { expect, test } from '@playwright/test';
import { enterSeatmap, openSectionA, selectSeat } from '../helpers/booking-steps.js';
import { reserveViaApi } from '../helpers/queue.js';
import { E2E_EVENTS } from '../seed.js';

const EVENT = E2E_EVENTS.taken;

test('notifierar när en vald stol tas av någon annan', async ({ page }) => {
  await enterSeatmap(page, EVENT.id, EVENT.title);
  await openSectionA(page);
  await selectSeat(page, 1);
  await expect(page.getByText('1/5 valda').first()).toBeVisible();

  await reserveViaApi(EVENT.id, EVENT.seatIds.slice(0, 1));

  await expect(page.getByText('Rad A plats 1 togs av någon annan')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: /Rad A, plats 1, .*upptagen/ })).toBeVisible();
  await expect(page.getByText('0/5 valda').first()).toBeVisible();
});
