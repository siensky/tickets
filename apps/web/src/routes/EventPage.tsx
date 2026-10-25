/**
 * Event detail + väntrum (docs/plan.md "Väntrum"). Joins the queue on
 * mount and polls admission; once admitted, links on to the seatmap.
 */
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getEvent } from '../lib/api-client.js';
import { useQueueAdmission } from '../hooks/use-queue-admission.js';

export function EventPage(): JSX.Element {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = rawEventId ?? '';

  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: eventId !== '',
  });
  const { status, isJoining, error } = useQueueAdmission(eventId);

  if (rawEventId === undefined) {
    return <p role="alert">Okänt evenemang.</p>;
  }
  if (eventQuery.isPending) {
    return <p>Laddar evenemang…</p>;
  }
  if (eventQuery.isError) {
    return <p role="alert">Kunde inte hämta evenemanget.</p>;
  }

  return (
    <section>
      <h1>{eventQuery.data.title}</h1>
      <p>
        {eventQuery.data.artist} — {eventQuery.data.venueName}, {eventQuery.data.venueCity}
      </p>
      <WaitingRoomStatus
        eventId={eventId}
        isJoining={isJoining}
        status={status}
        error={error}
      />
    </section>
  );
}

function WaitingRoomStatus({
  eventId,
  isJoining,
  status,
  error,
}: {
  eventId: string;
  isJoining: boolean;
  status: ReturnType<typeof useQueueAdmission>['status'];
  error: Error | undefined;
}): JSX.Element {
  if (error !== undefined) {
    return <p role="alert">Något gick fel i väntrummet: {error.message}</p>;
  }
  if (isJoining || status === undefined) {
    return <p>Ansluter till väntrummet…</p>;
  }
  if (status.status === 'waiting') {
    return (
      <p>
        Din plats i kön: {status.position} av {status.queueDepth}
      </p>
    );
  }
  if (status.status === 'admitted') {
    return (
      <p>
        Du är insläppt! <Link to={`/events/${eventId}/seatmap`}>Välj dina platser</Link>
      </p>
    );
  }
  if (status.status === 'sales_closed') {
    return <p>Försäljningen för det här evenemanget är stängd.</p>;
  }
  return (
    <p role="alert">Din kösession hittades inte längre. Ladda om sidan för att gå med igen.</p>
  );
}
