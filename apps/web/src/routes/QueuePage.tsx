/**
 * `/events/:eventId/queue` (docs/plan.md 7.11 C): väntrummet, utflyttat ur arenakartan. Efter
 * "Ställ dig i kön igen" monteras skärmen om (`key`), så att en ny kötoken hämtas.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { Container } from '../components/ui/Container.js';
import { QueueScreen } from '../features/queue/QueueScreen.js';
import { getEvent } from '../lib/api-client.js';
import { clearQueueToken } from '../lib/queue-token-storage.js';

export function QueuePage(): JSX.Element {
  const { eventId = '' } = useParams<{ eventId: string }>();
  const [attempt, setAttempt] = useState(0);
  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: eventId !== '',
  });

  function handleRejoin(): void {
    clearQueueToken(eventId);
    setAttempt((current) => current + 1);
  }

  return (
    <Container className="max-w-xl py-16">
      <h1 className="mb-1 text-center text-2xl sm:text-3xl">Väntrum</h1>
      <p className="mb-8 text-center text-muted">{eventQuery.data?.title ?? ' '}</p>
      <QueueScreen key={attempt} eventId={eventId} onRejoin={handleRejoin} />
    </Container>
  );
}
