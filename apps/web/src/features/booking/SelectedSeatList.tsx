/** De valda platserna som rader: "Rad C, plats 12" och priset. */
import type { JSX } from 'react';
import { formatPrice } from '../../lib/format.js';

export interface SummarySeat {
  readonly key: string;
  readonly row: string;
  readonly number: number;
  readonly sectionName: string;
  readonly priceCents: number;
}

export function SelectedSeatList({ seats }: { seats: readonly SummarySeat[] }): JSX.Element {
  return (
    <ul className="divide-y divide-base-300">
      {seats.map((seat) => (
        <li key={seat.key} className="flex items-baseline justify-between gap-3 py-2">
          <span>
            <span className="font-medium">
              Rad {seat.row}, plats {seat.number}
            </span>
            <span className="block text-sm text-muted">{seat.sectionName}</span>
          </span>
          <span className="tabular-nums">{formatPrice(seat.priceCents)}</span>
        </li>
      ))}
    </ul>
  );
}
