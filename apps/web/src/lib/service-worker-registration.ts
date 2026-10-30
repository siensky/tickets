/**
 * Registers the Workbox service worker built by vite-plugin-pwa
 * (docs/plan.md "Offline": app shell + "mina biljetter" work offline;
 * booking does not, and still shows its usual network-error states
 * when offline — there is no special offline UI for the booking flow).
 *
 * Bara i produktionsbygget. Under `vite dev` (localhost) registreras ingen service worker, och
 * en som blivit kvar från ett tidigare bygge på samma adress avregistreras: annars serverar den
 * gamla, cachade sidan och dev-servern verkar "ignorera" ändringar.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  if (import.meta.env.DEV) {
    void navigator.serviceWorker
      .getRegistrations()
      .then(async (registrations) => {
        await Promise.all(registrations.map((registration) => registration.unregister()));
        if (registrations.length > 0) {
          await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
          window.location.reload();
        }
      })
      .catch(() => undefined);
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No offline support is an acceptable degradation — booking
      // already requires network regardless of the service worker.
    });
  });
}
