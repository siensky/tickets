/**
 * Kopplar inloggningen till PostHog: `identify(sub)` när en användare är inloggad och har
 * samtyckt (docs/plan.md 7.7). Renderar ingenting. `reset()` vid utloggning görs i `useLogout`.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useEffect } from 'react';
import { identifyUser } from '../../lib/analytics.js';
import { useConsent } from '../../lib/consent.js';

export function AnalyticsBridge(): null {
  const { isAuthenticated, user } = useAuth0();
  const consent = useConsent();
  const sub = user?.sub;

  useEffect(() => {
    if (isAuthenticated && consent === 'granted' && sub !== undefined) {
      identifyUser(sub);
    }
  }, [isAuthenticated, consent, sub]);

  return null;
}
