/**
 * Eventsidan (docs/plan.md 7.11 B): hero, infoblock, "Boka biljetter" (sticky på mobil) och
 * viktig information. Knappen leder till kön (`/events/:id/queue`); sidan ställer inte själv
 * användaren i kön längre.
 */
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, buttonClass } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { Container } from '../components/ui/Container.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Skeleton } from '../components/ui/Skeleton.js';
import { isBookable } from '../features/events/AvailabilityBadge.js';
import { EventHero } from '../features/events/EventHero.js';
import { EventInfo } from '../features/events/EventInfo.js';
import { getEvent, type EventSummary } from '../lib/api-client.js';

function BookButton({
  event,
  className = '',
}: {
  event: EventSummary;
  className?: string;
}): JSX.Element {
  if (isBookable(event.availability)) {
    return (
      <Link
        to={`/events/${event.id}/queue`}
        className={buttonClass('primary', 'lg', className)}
      >
        Boka biljetter
      </Link>
    );
  }
  return (
    <Button size="lg" disabled className={className}>
      {event.availability === 'opens_soon'
        ? 'Försäljningen har inte öppnat'
        : 'Inte till salu'}
    </Button>
  );
}

function ImportantInfo({ description }: { description: string | null }): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      {description === null ? null : (
        <div>
          <h2 className="mb-2">Om evenemanget</h2>
          <p className="max-w-prose whitespace-pre-line">{description}</p>
        </div>
      )}
      <Card>
        <h2 className="mb-3 text-lg">Bra att veta</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Max 5 biljetter per köp.</li>
          <li>Dina platser hålls i 5 minuter medan du betalar.</li>
          <li>Biljetterna visas med QR-kod under Mina biljetter.</li>
        </ul>
      </Card>
    </section>
  );
}

function EventPageSkeleton(): JSX.Element {
  return (
    <>
      <Skeleton className="aspect-[4/3] w-full sm:aspect-[16/7]" />
      <Container className="flex flex-col gap-4 py-8">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-6 w-48" />
      </Container>
    </>
  );
}

export function EventPage(): JSX.Element {
  const { eventId = '' } = useParams<{ eventId: string }>();
  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: eventId !== '',
    // Försäljningen kan öppna medan sidan är öppen: hämta om tills eventet inte längre är "snart".
    refetchInterval: (query) =>
      query.state.data?.availability === 'opens_soon' ? 5000 : false,
  });

  if (eventQuery.isError) {
    return (
      <Container>
        <ErrorState
          message="Kunde inte hämta evenemanget."
          onRetry={() => void eventQuery.refetch()}
        />
      </Container>
    );
  }
  if (eventQuery.isPending) {
    return <EventPageSkeleton />;
  }
  const event = eventQuery.data;
  return (
    <>
      <EventHero event={event} />
      <Container className="grid gap-8 py-8 pb-28 lg:grid-cols-[1fr_360px] lg:pb-12">
        <div className="flex flex-col gap-8">
          <EventInfo event={event} />
          <ImportantInfo description={event.description} />
        </div>
        <aside className="hidden self-start lg:sticky lg:top-24 lg:block">
          <Card className="flex flex-col gap-4 shadow-lg">
            <h2 className="text-lg">Biljetter</h2>
            <BookButton event={event} className="w-full" />
          </Card>
        </aside>
      </Container>
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-base-300 bg-base-100 p-3 shadow-lg lg:hidden">
        <BookButton event={event} className="w-full" />
      </div>
    </>
  );
}
