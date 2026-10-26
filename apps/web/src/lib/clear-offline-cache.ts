/**
 * Clears the offline "mina biljetter" cache on logout. The Workbox
 * runtime cache configured in vite.config.ts is keyed only by URL, not
 * by who's signed in — on a shared device, a stale cache entry could
 * otherwise keep serving the PREVIOUS user's QR tickets (their entry
 * credentials, docs/plan.md "Säkerhet") after they've logged out.
 */
export async function clearMyTicketsOfflineCache(): Promise<void> {
  if (!('caches' in window)) {
    return;
  }
  try {
    await caches.delete('my-tickets');
  } catch {
    // Best-effort — nothing else to do if Cache Storage is unavailable.
  }
}
