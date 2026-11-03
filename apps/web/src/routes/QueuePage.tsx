/**
 * `/events/:eventId/queue` (docs/plan.md 7.11 C): väntrummet, utflyttat ur arenakartan. Efter
 * "Ställ dig i kön igen" monteras skärmen om (`key`), så att en ny kötoken hämtas.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { BackLink } from '../components/ui/BackLink.js';
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

  const handleRejoin = useCallback((): void => {
    clearQueueToken(eventId);
    setAttempt((current) => current + 1);
  }, [eventId]);

  // En token som sparats från ett tidigare besök och hunnit gå ut ersätts tyst med en ny, en gång:
  // användaren ska inte mötas av "din plats har gått ut" när hen bara kommer tillbaka till eventet.
  // Går även den nya platsen bort visas knappen i stället, så det aldrig blir en loop.
  const hasAutoRejoined = useRef(false);
  const handleExpired = useCallback((): void => {
    if (!hasAutoRejoined.current) {
      hasAutoRejoined.current = true;
      handleRejoin();
    }
  }, [handleRejoin]);

  return (
    <Container className="flex max-w-xl flex-col py-10">
      <BackLink to={`/events/${eventId}`}>Till evenemanget</BackLink>
      <h1 className="mb-1 mt-6 text-center text-2xl sm:text-3xl">Till bokningen</h1>
      <p className="mb-8 text-center text-muted">{eventQuery.data?.title ?? ' '}</p>
      <QueueScreen
        key={attempt}
        eventId={eventId}
        onRejoin={handleRejoin}
        onExpired={handleExpired}
      />
    </Container>
  );
}
