/**
 * Infoblocket på eventsidan (docs/plan.md 7.11 B): datum och tid, arena, prisintervall och
 * säljstatus. Inte öppnat än: nedräkning. Slutsålt/stängt: texten säger det.
 */
import { CalendarDays, MapPin, Ticket } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import type { EventSummary } from '../../lib/api-client.js';
import { formatEventDate, formatPriceRange } from '../../lib/format.js';
import { AvailabilityBadge } from './AvailabilityBadge.js';
import { SalesCountdown } from './SalesCountdown.js';

function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-1 text-primary" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

function SalesNote({ event }: { event: EventSummary }): JSX.Element | null {
  switch (event.availability) {
    case 'opens_soon':
      return <SalesCountdown openAt={event.salesOpenAt} />;
    case 'sold_out':
      return <p>Det här evenemanget är slutsålt.</p>;
    case 'closed':
      return <p>Försäljningen är stängd.</p>;
    default:
      return null;
  }
}

export function EventInfo({ event }: { event: EventSummary }): JSX.Element {
  const price = formatPriceRange(event.minPriceCents, event.maxPriceCents);
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        <InfoRow icon={<CalendarDays size={20} strokeWidth={1.75} />}>
          {formatEventDate(event.startsAt)}
        </InfoRow>
        <InfoRow icon={<MapPin size={20} strokeWidth={1.75} />}>
          {event.venueName}, {event.venueCity}
        </InfoRow>
        {price === '' ? null : (
          <InfoRow icon={<Ticket size={20} strokeWidth={1.75} />}>
            <span className="tabular-nums">{price}</span>
          </InfoRow>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <AvailabilityBadge availability={event.availability} />
        <SalesNote event={event} />
      </div>
    </div>
  );
}
