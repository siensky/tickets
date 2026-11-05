/**
 * Arenakarta (docs/plan.md 7.11 D): översikt över sektionerna, därefter sektionsvyn med
 * stolarna. Köhanteringen bor på `/events/:id/queue`; den som inte är insläppt skickas dit.
 * Bara `useQueueAdmission` avgör om användaren släpps in.
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { BackLink } from '../components/ui/BackLink.js';
import { Button } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Skeleton } from '../components/ui/Skeleton.js';
import { SectionSeats } from '../features/seatmap/SectionSeats.js';
import { VenueOverview } from '../features/seatmap/VenueOverview.js';
import { useQueueAdmission } from '../hooks/use-queue-admission.js';
import {
  cancelReservation,
  getEvent,
  getSectionSummary,
  type EventSummary,
  type SectionSummary,
} from '../lib/api-client.js';
import { clearLastReservationId, getLastReservationId } from '../lib/reservation-storage.js';

/** Escape går tillbaka till översikten, men aldrig medan en dialog är öppen. */
function useEscapeToGoBack(isActive: boolean, onBack: () => void): void {
  useEffect(() => {
    if (!isActive) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && document.querySelector('dialog[open]') === null) {
        onBack();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, onBack]);
}

/**
 * Kommer användaren till kartan med en reservation som DEN HÄR FLIKEN skapade (bakåt, hem och tillbaka) är
 * den övergiven: släpp stolarna direkt, så att de inte står som upptagna för hen själv tills tiden gått ut.
 * Gäller ett bestämt id och bara denna flik (sessionStorage), så en annan flik eller en nyare reservation
 * aldrig påverkas. Gick fliken vidare till Stripe utan att betala låter servern sessionen gå ut och släpper
 * även den (en betald session rörs aldrig). Misslyckas anropet ersätts en aktiv reservation ändå vid nästa
 * reservation. En duplicerad flik kopierar sessionStorage och kan därför avbryta originalflikens öppna
 * betalning: medvetet accepterat, det är samma kund.
 */
function useReleaseAbandonedReservation(
  eventId: string,
  queueToken: string | undefined,
): void {
  useEffect(() => {
    const reservationId = getLastReservationId(eventId);
    if (queueToken !== undefined && reservationId !== undefined) {
      // Glöms först när avbokningen gått igenom: avbryts anropet (t.ex. av en omladdning till en ny version
      // av appen) görs det om nästa gång kartan öppnas. Avbokningen är idempotent.
      cancelReservation(eventId, reservationId, queueToken)
        .then(() => clearLastReservationId(eventId, reservationId))
        .catch(() => undefined);
    }
  }, [eventId, queueToken]);
}

function MapSkeleton(): JSX.Element {
  return (
    <Container className="flex flex-col gap-4 py-8">
      <Skeleton className="h-10 w-80" />
      <Skeleton className="h-96 w-full" />
    </Container>
  );
}

function SeatmapContent({
  event,
  summary,
  queueToken,
}: {
  event: EventSummary;
  summary: SectionSummary;
  queueToken: string | undefined;
}): JSX.Element {
  const [sectionId, setSectionId] = useState<string | undefined>();
  useReleaseAbandonedReservation(event.id, queueToken);
  useEscapeToGoBack(sectionId !== undefined, () => setSectionId(undefined));
  const section = summary.sections.find((entry) => entry.id === sectionId);
  return (
    <Container className="flex flex-col gap-6 py-8">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {section === undefined ? (
          <BackLink to={`/events/${event.id}`}>Till evenemanget</BackLink>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setSectionId(undefined)}>
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Alla sektioner
          </Button>
        )}
        <div>
          <h1 className="text-2xl sm:text-3xl">{section?.name ?? 'Välj sektion'}</h1>
          <p className="text-sm text-muted">{event.title}</p>
        </div>
      </header>
      {section === undefined ? (
        <VenueOverview summary={summary} onSelect={setSectionId} />
      ) : (
        <SectionSeats
          eventId={event.id}
          eventTitle={event.title}
          venueId={event.venueId}
          sectionId={section.id}
          sectionName={section.name}
          queueToken={queueToken}
        />
      )}
    </Container>
  );
}

export function SeatmapPage(): JSX.Element {
  const { eventId = '' } = useParams<{ eventId: string }>();
  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: eventId !== '',
  });
  const summaryQuery = useQuery({
    queryKey: ['section-summary', eventId],
    queryFn: () => getSectionSummary(eventId),
    enabled: eventId !== '',
    refetchInterval: 10_000,
  });
  const {
    token,
    status,
    error: queueError,
  } = useQueueAdmission(eventId, {
    listenForAdmission: false,
  });

  // Misslyckad kö (utgången token, stängd försäljning) hanteras av kösidan.
  if (queueError !== undefined || (status !== undefined && status.status !== 'admitted')) {
    return <Navigate to={`/events/${eventId}/queue`} replace />;
  }
  if (eventQuery.isError || summaryQuery.isError) {
    return (
      <Container>
        <ErrorState
          message="Kunde inte hämta arenakartan."
          onRetry={() => {
            void eventQuery.refetch();
            void summaryQuery.refetch();
          }}
        />
      </Container>
    );
  }
  if (eventQuery.isPending || summaryQuery.isPending || status === undefined) {
    return <MapSkeleton />;
  }
  return (
    <SeatmapContent event={eventQuery.data} summary={summaryQuery.data} queueToken={token} />
  );
}
