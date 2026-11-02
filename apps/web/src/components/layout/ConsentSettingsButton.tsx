/** "Cookie-inställningar": öppnar samtyckesbannern igen (docs/plan.md 7.7). Dold utan analytics. */
import type { JSX } from 'react';
import { isAnalyticsConfigured } from '../../lib/analytics.js';
import { openConsentSettings } from '../../lib/consent.js';
import { Button } from '../ui/Button.js';

export function ConsentSettingsButton({
  className = '',
}: {
  className?: string;
}): JSX.Element | null {
  if (!isAnalyticsConfigured) {
    return null;
  }
  return (
    <Button variant="ghost" size="sm" className={className} onClick={openConsentSettings}>
      Cookie-inställningar
    </Button>
  );
}
