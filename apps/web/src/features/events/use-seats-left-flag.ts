/**
 * Feature-flaggan `show_seats_left_badge` (docs/plan.md 7.7). `false` tills PostHog svarat, och
 * alltid `false` utan samtycke (flaggor utvärderas då inte): användaren ser default, ingen badge.
 */
import { useEffect, useState } from 'react';
import { subscribeSeatsLeftFlag } from '../../lib/analytics.js';
import { useConsent } from '../../lib/consent.js';

export function useSeatsLeftFlag(): boolean {
  const consent = useConsent();
  const [isOn, setIsOn] = useState(false);
  useEffect(() => {
    if (consent !== 'granted') {
      setIsOn(false);
      return undefined;
    }
    return subscribeSeatsLeftFlag(setIsOn);
  }, [consent]);
  return isOn;
}
