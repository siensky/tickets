/**
 * PostHog i webbläsaren (docs/plan.md 7.7). Allt går via typade `track()` (händelsekatalogen
 * i @tickets/analytics) och är no-op utan `VITE_POSTHOG_KEY` (lokalt, CI, tester).
 *
 * Samtycke: utan godkännande körs PostHog cookielöst (`persistence: 'memory'`, nytt anonymt
 * id vid varje sidladdning), ingen `identify` och inga feature flags. Flaggor utvärderas bara
 * efter samtycke eftersom varianten annars skulle hoppa mellan sidladdningar.
 * Händelser går via `/ingest` (Cloudflare-Workern), så adblockers inte tar dem.
 */
import { createTracker, type ClientEvents } from '@tickets/analytics';
import posthog from 'posthog-js';
import { getConsent, type ConsentChoice } from './consent.js';
import { sanitizeEventUrls } from './sanitize-url.js';

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
    disable_session_recording: true,
    // Auth0:s code/state och söktexten får aldrig följa med i $current_url.
    before_send: sanitizeEventUrls,
    advanced_disable_feature_flags_on_first_load: !hasConsent,
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
    return;
  }
  // Återkallat eller nekat: tillbaka till cookielöst, och glöm bort ett tidigare id.
  // Minnet först, sedan reset(): annars skrivs det nya id:t till cookien innan bytet.
  posthog.clear_opt_in_out_capturing();
  posthog.set_config({ persistence: 'memory' });
  posthog.reset();
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
