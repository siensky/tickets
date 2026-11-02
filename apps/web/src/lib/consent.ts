/**
 * Analyssamtycke (docs/plan.md 7.7). Valet sparas i `localStorage` och kan ändras via
 * "Cookie-inställningar" i navbaren. Utan samtycke körs PostHog cookielöst (minnesbaserat id).
 */
import { useSyncExternalStore } from 'react';

export type ConsentChoice = 'granted' | 'denied' | 'unset';

export const CONSENT_STORAGE_KEY = 'tikknet:analytics-consent';
const CHANGE_EVENT = 'tikknet:consent-changed';
export const OPEN_CONSENT_EVENT = 'tikknet:open-consent';

export function getConsent(): ConsentChoice {
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === 'granted' || stored === 'denied' ? stored : 'unset';
  } catch {
    // localStorage kan saknas eller blockeras (privat läge): behandla som "inget val".
    return 'unset';
  }
}

export function storeConsent(choice: 'granted' | 'denied'): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // Valet gäller då bara tills sidan laddas om; ingenting att göra åt det.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useConsent(): ConsentChoice {
  return useSyncExternalStore(subscribe, getConsent, () => 'unset');
}

export function openConsentSettings(): void {
  window.dispatchEvent(new Event(OPEN_CONSENT_EVENT));
}
