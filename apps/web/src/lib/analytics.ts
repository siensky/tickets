/**
 * PostHog i webbläsaren (docs/plan.md 7.7). Allt går via typade `track()` (händelsekatalogen
 * i @tickets/analytics) och är no-op utan `VITE_POSTHOG_KEY` (lokalt, CI, tester).
 *
 * Samtycke: utan godkännande körs PostHog cookielöst (`persistence: 'memory'`, nytt anonymt
 * id vid varje sidladdning), ingen `identify` och inga feature flags. Flaggor utvärderas bara
 * efter samtycke eftersom varianten annars skulle hoppa mellan sidladdningar.
 * Händelser går via `/ingest` (Cloudflare-Workern), så adblockers inte tar dem.
 *
 * Session replay (docs/plan.md 8.4) startar BARA efter samtycke och är maskerad: all text och alla fält,
 * ingen nätverksinspelning, URL:er rensas, och känsliga sidor (QR, checkout, Mina biljetter) blockeras med
 * `ph-no-capture`. Den startar inte medan Auth0:s återkomst (`?code=&state=`) ligger i adressfältet.
 */
import { createTracker, type ClientEvents } from '@tickets/analytics';
import posthog from 'posthog-js';
import { CONSENT_STORAGE_KEY, getConsent, type ConsentChoice } from './consent.js';
import { sanitizeEventUrls, sanitizeUrl } from './sanitize-url.js';

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? '/ingest';
const POSTHOG_UI_HOST = 'https://eu.posthog.com';
const SEATS_LEFT_FLAG = 'show_seats_left_badge';

// Händelser som följs av en helsidesnavigering (checkout → Stripe) skickas direkt: en köad händelse
// tappas annars när sidan lämnas, och tratten förlorar steget före betalningen.
const INSTANT_EVENTS: ReadonlySet<string> = new Set(['checkout_started']);

export const isAnalyticsConfigured = POSTHOG_KEY !== undefined && POSTHOG_KEY !== '';

const tracker = createTracker<ClientEvents>(
  isAnalyticsConfigured
    ? {
        capture: (name, props) => {
          posthog.capture(
            name,
            { ...props },
            INSTANT_EVENTS.has(name) ? { send_instantly: true } : undefined,
          );
        },
      }
    : null,
);

export function track<Name extends keyof ClientEvents>(
  name: Name,
  props: ClientEvents[Name],
): void {
  tracker.track(name, props);
}

const MASKED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-label',
  'aria-description',
  'title',
  'alt',
  'placeholder',
]);
const AUTH0_CALLBACK_PARAMS = /[?&](code|state)=/;
const REPLAY_RETRY_MS = 500;
const REPLAY_MAX_RETRIES = 20;

/** Startar inspelningen när samtycke finns och adressfältet inte bär Auth0:s `code`/`state`. */
function startReplayWhenSafe(retriesLeft = REPLAY_MAX_RETRIES): void {
  if (getConsent() !== 'granted') {
    return;
  }
  if (AUTH0_CALLBACK_PARAMS.test(window.location.search)) {
    // Tar väntan slut (t.ex. en misslyckad Auth0-återkomst som lämnar ?error=&state= kvar) startar vi inte.
    if (retriesLeft > 0) {
      setTimeout(() => startReplayWhenSafe(retriesLeft - 1), REPLAY_RETRY_MS);
    }
    return;
  }
  posthog.startSessionRecording();
}

export function initAnalytics(): void {
  if (POSTHOG_KEY === undefined || POSTHOG_KEY === '') {
    return;
  }
  const hasConsent = getConsent() === 'granted';
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    ui_host: POSTHOG_UI_HOST,
    persistence: hasConsent ? 'localStorage+cookie' : 'memory',
    capture_pageview: 'history_change',
    // Bara händelserna i katalogen: autocapture skulle skicka godtycklig DOM-text.
    autocapture: false,
    // Av vid start; slås på först efter samtycke (startReplayWhenSafe).
    disable_session_recording: true,
    // Konsolrader och nätverkstiming kan innehålla URL:er med code/state eller e-post: av uttryckligen i stället
    // för att följa projektets fjärrinställning.
    enable_recording_console_log: false,
    capture_performance: { network_timing: false, web_vitals: false },
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      // maskTextSelector täcker bara textnoder. Attribut som kan bära namn eller e-post (t.ex. kontomenyns
      // aria-label) maskeras här.
      maskAttributeFn: (name, value) =>
        MASKED_ATTRIBUTES.has(name) ? '*'.repeat(value.length) : value,
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: sanitizeUrl(request.name ?? ''),
      }),
    },
    // Auth0:s code/state och söktexten får aldrig följa med i $current_url.
    before_send: sanitizeEventUrls,
    advanced_disable_feature_flags_on_first_load: !hasConsent,
  });
  startReplayWhenSafe();
  // Ett samtycke som ändras i en annan flik ska gälla här också (återkallat = inspelningen stoppas direkt).
  window.addEventListener('storage', (event) => {
    if (event.key === CONSENT_STORAGE_KEY) {
      applyConsent(getConsent());
    }
  });
}

/** Tillämpar ett nytt samtyckesval på den redan initierade klienten. */
export function applyConsent(choice: ConsentChoice): void {
  if (!isAnalyticsConfigured) {
    return;
  }
  if (choice === 'granted') {
    posthog.set_config({ persistence: 'localStorage+cookie' });
    posthog.opt_in_capturing();
    posthog.reloadFeatureFlags();
    startReplayWhenSafe();
    return;
  }
  // Återkallat eller nekat: tillbaka till cookielöst, och glöm bort ett tidigare id.
  const wasRecording = posthog.sessionRecordingStarted();
  posthog.clear_opt_in_out_capturing();
  posthog.set_config({ persistence: 'memory', disable_session_recording: true });
  posthog.reset();
  posthog.stopSessionRecording();
  if (wasRecording) {
    // posthog-js startar om inspelningen när reset() skapar en ny session, trots att den är avstängd i
    // konfigurationen (verifierat i webbläsare, även med flaggor avstängda och onSessionId). En omladdning är
    // det enda tillförlitliga sättet att garantera att inspelningen slutar när samtycket återkallas.
    window.location.reload();
  }
}

/** Auth0 `sub` är ett opakt id utan PII (docs/plan.md 7.7). Bara efter samtycke. */
export function identifyUser(sub: string): void {
  if (isAnalyticsConfigured && getConsent() === 'granted') {
    posthog.identify(sub);
  }
}

export function resetAnalytics(): void {
  if (isAnalyticsConfigured) {
    posthog.reset();
  }
}

/** Anropar `onChange` med flaggans värde när flaggorna laddats. Returnerar en avprenumeration. */
export function subscribeSeatsLeftFlag(onChange: (isOn: boolean) => void): () => void {
  if (!isAnalyticsConfigured || getConsent() !== 'granted') {
    return () => undefined;
  }
  return posthog.onFeatureFlags(() => {
    onChange(posthog.isFeatureEnabled(SEATS_LEFT_FLAG) === true);
  });
}
