/**
 * Eventkort (docs/plan.md 7.11 A): bild 16:9, datumblock, titel, artist, "arena · stad",
 * "från X kr" och säljstatus. "Köp biljetter" leder till eventsidan och in i bokningsflödet.
 * Slutsålda och stängda event får en avstängd knapp i stället för länk.
 */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import type { EventSummary } from '../../lib/api-client.js';
import { CATEGORY_LABELS } from '../../lib/categories.js';
import { formatPrice, getEventDateParts } from '../../lib/format.js';
import { AvailabilityBadge, isBookable } from './AvailabilityBadge.js';
import { EventImage } from './EventImage.js';

function DateBlock({ iso }: { iso: string }): JSX.Element {
  const { day, month } = getEventDateParts(iso);
  return (
    <div className="absolute top-3 left-3 flex w-12 flex-col items-center rounded-field bg-base-100 py-1 text-center shadow-sm">
      <span className="label-caps text-primary">{month}</span>
      <span className="text-lg leading-tight font-bold tabular-nums">{day}</span>
    </div>
  );
}

export function EventCard({ event }: { event: EventSummary }): JSX.Element {
  const bookable = isBookable(event.availability);
  return (
    <Card interactive className="flex h-full flex-col overflow-hidden p-0!">
      <EventImage event={event}>
        <DateBlock iso={event.startsAt} />
      </EventImage>
      <article className="flex flex-1 flex-col gap-1 p-4 sm:p-5">
        <p className="label-caps text-muted">{CATEGORY_LABELS[event.category]}</p>
        <h3 className="text-lg">{event.title}</h3>
        <p className="text-muted">{event.artist}</p>
        <p className="text-sm text-muted">
          {event.venueName} · {event.venueCity}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AvailabilityBadge availability={event.availability} />
          {event.minPriceCents === null ? null : (
            <span className="text-sm font-medium tabular-nums">
              från {formatPrice(event.minPriceCents)}
            </span>
          )}
        </div>
        <div className="mt-auto pt-4">
          {bookable ? (
            <Link
              to={`/events/${event.id}`}
              className={buttonClass('primary', 'md', 'w-full')}
              aria-label={`Köp biljetter till ${event.title}`}
            >
              Köp biljetter
            </Link>
          ) : (
            <Link
              to={`/events/${event.id}`}
              className={buttonClass('secondary', 'md', 'w-full')}
              aria-label={`Visa ${event.title}`}
            >
              Visa evenemang
            </Link>
          )}
        </div>
      </article>
    </Card>
  );
}
