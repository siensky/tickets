/** Förklaring av stolsstatus, alltid synlig ovanför kartan. Samma former som i Seat. */
import type { JSX } from 'react';
import { SeatPatterns, SeatShape, type SeatVisualState } from './Seat.js';

const ITEMS: readonly { state: SeatVisualState; label: string }[] = [
  { state: 'available', label: 'Ledig' },
  { state: 'selected', label: 'Vald av dig' },
  { state: 'held', label: 'Upptagen just nu' },
  { state: 'sold', label: 'Såld' },
];

export function SeatLegend(): JSX.Element {
  return (
    <ul aria-label="Förklaring" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      {ITEMS.map(({ state, label }) => (
        <li key={state} className="flex items-center gap-2">
          <svg viewBox="-0.6 -0.6 1.2 1.2" width={22} height={22} aria-hidden="true">
            <SeatPatterns />
            <SeatShape state={state} x={0} y={0} />
          </svg>
          {label}
        </li>
      ))}
    </ul>
  );
}
