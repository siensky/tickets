/**
 * Klick på en upptagen stol: visar en live-nedräkning till när reservationen går ut (serverns `heldUntil`
 * ur stolsstatusen). Stolen blir ledig först när städjobbet släppt den, så vid 0 står det "strax".
 * Är stolen redan ledig igen, eller såld, ändras texten i stället för att visa en gammal nedräkning.
 */
import { Clock } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useRemainingSeconds, formatClock } from '../../components/Countdown.js';
import type { SeatGeometry, SeatStatusEntry } from '../../lib/api-client.js';

function Remaining({ heldUntil }: { heldUntil: string }): JSX.Element {
  const seconds = useRemainingSeconds(heldUntil);
  return seconds === 0 ? (
    <>Reservationen har gått ut, stolen släpps strax.</>
  ) : (
    <>
      Blir ledig igen om{' '}
      <span role="timer" className="font-bold tabular-nums">
        {formatClock(seconds)}
      </span>{' '}
      om den inte köps.
    </>
  );
}

function describe(entry: SeatStatusEntry): JSX.Element {
  if (entry.status === 'available') {
    return <>Stolen är ledig igen. Du kan välja den nu.</>;
  }
  if (entry.status === 'sold') {
    return <>Stolen har sålts.</>;
  }
  // `typeof`, inte `=== null`: ett svar från en äldre podd (rullande deploy) saknar fältet helt.
  return typeof entry.heldUntil === 'string' ? (
    <Remaining heldUntil={entry.heldUntil} />
  ) : (
    <>Reserverad, betalning pågår.</>
  );
}

export function HeldSeatNotice({
  seat,
  entry,
}: {
  seat: SeatGeometry;
  entry: SeatStatusEntry;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-field bg-base-200 px-4 py-3 text-sm">
      <Clock size={18} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <p>
        <span className="font-medium">
          Rad {seat.row}, plats {seat.number}:
        </span>{' '}
        {describe(entry)}
      </p>
    </div>
  );
}

/** Klick på en upptagen stol (`inspect`) visar `notice`, som följer stolens status vid varje poll. */
export function useHeldSeatNotice(
  geometry: readonly SeatGeometry[],
  seatStatuses: readonly SeatStatusEntry[],
): { notice: JSX.Element; inspect: (venueSeatId: string) => void } {
  const [venueSeatId, setVenueSeatId] = useState<string | undefined>();
  const seat = geometry.find((candidate) => candidate.id === venueSeatId);
  const entry = seatStatuses.find((candidate) => candidate.venueSeatId === venueSeatId);
  return {
    // Live region som alltid finns i DOM:en, så att en skärmläsare läser upp texten när den dyker upp.
    notice: (
      <div role="status">
        {seat === undefined || entry === undefined ? null : (
          <HeldSeatNotice seat={seat} entry={entry} />
        )}
      </div>
    ),
    inspect: setVenueSeatId,
  };
}
