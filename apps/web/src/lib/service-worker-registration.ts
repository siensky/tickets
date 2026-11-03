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
  newVersionReady = watchForNewVersion(navigator.serviceWorker);
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => checkForUpdatesWhenVisible(registration))
      .catch(() => {
        // No offline support is an acceptable degradation — booking
        // already requires network regardless of the service worker.
      });
  });
}

/** Det enda service workern behöver: vem som styr sidan nu, och besked när det byts. */
export interface ServiceWorkerTakeoverSource {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

let newVersionReady: () => boolean = () => false;

/** `true` när en nyare version tagit över efter att sidan laddades (se `useReloadIntoNewVersion`). */
export function isNewVersionReady(): boolean {
  return newVersionReady();
}

/**
 * Efter en deploy installerar den nya service workern sig och tar över direkt (`autoUpdate` =
 * skipWaiting + clientsClaim), men den öppna sidan kör fortfarande den gamla JavaScript-koden tills den
 * laddas om; navigering inne i appen räcker inte. Här noteras bara att en NY version tagit över (inte
 * första installationen). Själva omladdningen görs vid nästa sidbyte
 * (`useReloadIntoNewVersion`), aldrig mitt i en inloggning eller ett pågående anrop.
 */
export function watchForNewVersion(source: ServiceWorkerTakeoverSource): () => boolean {
  // Startade sidan utan kontrollant är första bytet bara att den första versionen tar över (clientsClaim):
  // hoppa över det, men fortsätt lyssna, så att senare versioner ändå laddas in.
  let takeoversToIgnore = source.controller === null ? 1 : 0;
  let isReady = false;
  source.addEventListener('controllerchange', () => {
    if (takeoversToIgnore > 0) {
      takeoversToIgnore -= 1;
      return;
    }
    isReady = true;
  });
  return () => isReady;
}

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Webbläsaren letar bara efter en ny version vid en hel sidladdning: gör det också när fliken visas igen,
 * men högst var tionde minut, så att tiotusentals besökare som byter flik under en försäljning inte
 * hämtar `sw.js` hela tiden.
 */
function checkForUpdatesWhenVisible(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState !== 'visible' ||
      Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS
    ) {
      return;
    }
    lastCheck = Date.now();
    registration.update().catch(() => undefined);
  });
}
