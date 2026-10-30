/**
 * Bokningssammanfattningen (docs/plan.md 7.11 E): valda stolar, en PRELIMINÄR summa (summan
 * av priserna i stolsstatusen) och "Reservera och gå vidare". Den slutliga summan kommer
 * från serverns reservation på nästa steg. Inga avgifter: backend har inga.
 */
import { useId, type JSX } from 'react';
import { Alert } from '../../components/ui/Alert.js';
import { Button } from '../../components/ui/Button.js';
import { formatPrice } from '../../lib/format.js';
import { SelectedSeatList, type SummarySeat } from './SelectedSeatList.js';

export const MAX_SEATS_PER_RESERVATION = 5;

export function sumPreliminary(seats: readonly SummarySeat[]): number {
  return seats.reduce((sum, seat) => sum + seat.priceCents, 0);
}

export interface BookingSummaryProps {
  readonly eventTitle: string;
  readonly seats: readonly SummarySeat[];
  readonly isReserving: boolean;
  readonly errorMessage: string | undefined;
  readonly onReserve: () => void;
}

function PreliminaryTotal({ seats }: { seats: readonly SummarySeat[] }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between border-t border-base-300 pt-3">
      <span>
        Preliminär summa
        <span className="block text-xs text-muted">
          Slutligt belopp visas vid reservationen
        </span>
      </span>
      <span className="text-xl font-bold tabular-nums">
        {formatPrice(sumPreliminary(seats))}
      </span>
    </div>
  );
}

export function BookingSummaryPanel({
  eventTitle,
  seats,
  isReserving,
  errorMessage,
  onReserve,
}: BookingSummaryProps): JSX.Element {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-box border border-base-300 bg-base-100 p-5 shadow-lg"
    >
      <div>
        <h2 id={titleId} className="text-lg">
          Din bokning
        </h2>
        <p className="text-sm text-muted">{eventTitle}</p>
      </div>
      <p className="text-sm font-medium" aria-live="polite">
        {seats.length}/{MAX_SEATS_PER_RESERVATION} valda
      </p>
      {seats.length === 0 ? (
        <p className="text-muted">
          Välj upp till {MAX_SEATS_PER_RESERVATION} platser på kartan.
        </p>
      ) : (
        <>
          <SelectedSeatList seats={seats} />
          <PreliminaryTotal seats={seats} />
        </>
      )}
      {errorMessage === undefined ? null : <Alert tone="error">{errorMessage}</Alert>}
      <Button
        size="lg"
        loading={isReserving}
        disabled={seats.length === 0}
        onClick={onReserve}
      >
        Reservera och gå vidare
      </Button>
    </section>
  );
}
