/**
 * Ett evenemangskort på startsidan (docs/plan.md Fas 6). "Köp
 * biljetter" leder in i det redan byggda flödet (EventPage →
 * SeatmapPage → ReservationPage → checkout) — kortet själv gör
 * ingenting mer än att länka dit.
 */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { EventSummary } from '../lib/api-client.js';
import { CATEGORY_LABELS } from '../lib/categories.js';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function EventCard({ event }: { event: EventSummary }): JSX.Element {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-muted-light bg-paper shadow-sm transition-shadow hover:shadow-md">
      <div className="flex h-32 items-center justify-center bg-ink text-paper">
        <span className="text-xs font-semibold tracking-widest uppercase text-paper/70">
          {CATEGORY_LABELS[event.category]}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-lg font-bold text-ink">{event.title}</h3>
        <p className="text-sm text-muted">{event.artist}</p>
        <p className="text-sm text-muted">
          {event.venueName}, {event.venueCity}
        </p>
        <p className="text-sm font-medium text-accent-blue">{formatDate(event.startsAt)}</p>
        <Link
          to={`/events/${event.id}`}
          className="mt-3 inline-block rounded-full bg-brand-red px-4 py-2 text-center text-sm font-semibold text-paper transition-colors hover:bg-brand-red-dark"
        >
          Köp biljetter
        </Link>
      </div>
    </article>
  );
}
