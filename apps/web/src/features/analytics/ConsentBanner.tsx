/**
 * Samtyckesbanner för anonym statistik (docs/plan.md 7.7). Visas tills användaren valt, och
 * öppnas igen via "Cookie-inställningar" i navbaren. Dold helt när analytics inte är
 * konfigurerat (lokalt, CI), eftersom det då inte finns något att samtycka till.
 */
import { useEffect, useState, type JSX } from 'react';
import { Button } from '../../components/ui/Button.js';
import { applyConsent, isAnalyticsConfigured } from '../../lib/analytics.js';
import { OPEN_CONSENT_EVENT, storeConsent, useConsent } from '../../lib/consent.js';

export function ConsentBanner(): JSX.Element | null {
  const consent = useConsent();
  const [isReopened, setIsReopened] = useState(false);

  useEffect(() => {
    const open = (): void => setIsReopened(true);
    window.addEventListener(OPEN_CONSENT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, open);
  }, []);

  if (!isAnalyticsConfigured || (consent !== 'unset' && !isReopened)) {
    return null;
  }

  function choose(choice: 'granted' | 'denied'): void {
    storeConsent(choice);
    applyConsent(choice);
    setIsReopened(false);
  }

  return (
    <section
      aria-label="Samtycke till statistik"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-base-300 bg-base-100 p-4 shadow-lg"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-prose text-sm">
          Vi samlar in anonym statistik om hur bokningsflödet används och spelar in hur sidan
          används (all text och alla fält är maskerade, betalning och biljetter spelas aldrig
          in). Ingen personinformation. Godkänner du sparas ett anonymt id i din webbläsare.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => choose('denied')}>
            Avvisa
          </Button>
          <Button onClick={() => choose('granted')}>Godkänn</Button>
        </div>
      </div>
    </section>
  );
}
