/**
 * Reservationstimern (docs/plan.md 7.11 F): återstående tid ur serverns `expiresAt`, med
 * varning under 60 s. Varningen läses upp en gång (`role="status"`), inte varje sekund.
 */
import { Clock } from 'lucide-react';
import type { JSX } from 'react';
import { Countdown, useRemainingSeconds } from '../../components/Countdown.js';

const WARNING_SECONDS = 60;

export function ReservationTimer({ expiresAt }: { expiresAt: string }): JSX.Element {
  const seconds = useRemainingSeconds(expiresAt);
  const isWarning = seconds < WARNING_SECONDS;
  return (
    <div
      className={`flex items-center gap-3 rounded-field px-4 py-3 ${
        isWarning ? 'bg-error text-error-content' : 'bg-base-200'
      }`}
    >
      <Clock size={20} strokeWidth={1.75} aria-hidden="true" />
      <div className="flex-1 text-sm">Platserna hålls åt dig i</div>
      <div className="text-xl font-bold">
        <Countdown expiresAt={expiresAt} />
      </div>
      <span role="status" className="sr-only">
        {isWarning && seconds > 0 ? 'Mindre än en minut kvar av reservationen.' : ''}
      </span>
    </div>
  );
}
