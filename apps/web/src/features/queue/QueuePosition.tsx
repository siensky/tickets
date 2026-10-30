/**
 * "Du har plats 1 234 i kön" (docs/plan.md 7.11 C). Ingen väntetid och ingen progressbar:
 * backend ger ingen tillförlitlig siffra. En lugn puls visar att sidan lever. Positionen
 * läses upp via `aria-live="polite"` högst var 10:e sekund.
 */
import type { JSX } from 'react';
import { useThrottledValue } from './use-throttled-value.js';

const ANNOUNCE_INTERVAL_MS = 10_000;
const numberFormatter = new Intl.NumberFormat('sv-SE');

export function QueuePosition({
  position,
  queueDepth,
}: {
  position: number;
  queueDepth: number;
}): JSX.Element {
  const announced = useThrottledValue(position, ANNOUNCE_INTERVAL_MS);
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <span className="relative flex h-4 w-4" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex h-4 w-4 rounded-full bg-primary" />
      </span>
      <p className="text-xl">
        Du har plats{' '}
        <strong className="text-4xl font-extrabold tabular-nums text-primary">
          {numberFormatter.format(position)}
        </strong>{' '}
        i kön
      </p>
      <p className="text-muted tabular-nums">
        {numberFormatter.format(queueDepth)} personer köar
      </p>
      <p className="sr-only" aria-live="polite">
        Du har plats {numberFormatter.format(announced)} i kön.
      </p>
    </div>
  );
}
