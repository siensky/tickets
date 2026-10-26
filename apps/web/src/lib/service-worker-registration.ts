/**
 * Registers the Workbox service worker built by vite-plugin-pwa
 * (docs/plan.md "Offline": app shell + "mina biljetter" work offline;
 * booking does not, and still shows its usual network-error states
 * when offline — there is no special offline UI for the booking flow).
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No offline support is an acceptable degradation — booking
      // already requires network regardless of the service worker.
    });
  });
}
