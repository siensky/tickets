/**
 * Kösidans innehåll (docs/plan.md 7.11 C). Bara `useQueueAdmission` avgör om användaren släpps
 * in. Tillstånd: ansluter · väntar · insläppt (vidare till kartan) · försäljning stängd ·
 * kötoken utgången · tappad anslutning (banner, platsen behålls).
 */
import { useEffect, type JSX, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Alert } from '../../components/ui/Alert.js';
import { Button } from '../../components/ui/Button.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Spinner } from '../../components/ui/Spinner.js';
import { useQueueAdmission } from '../../hooks/use-queue-admission.js';
import { ApiError, type QueueStatusResult } from '../../lib/api-client.js';
import { ConnectionBanner } from './ConnectionBanner.js';
import { QueuePosition } from './QueuePosition.js';

function Centered({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-col items-center gap-6 py-6 text-center">{children}</div>;
}

function QueueState({
  status,
  hasConnectionError,
  onRejoin,
}: {
  status: QueueStatusResult;
  hasConnectionError: boolean;
  onRejoin: () => void;
}): JSX.Element {
  switch (status.status) {
    case 'waiting':
      return (
        <Centered>
          {hasConnectionError ? <ConnectionBanner /> : null}
          <QueuePosition position={status.position} queueDepth={status.queueDepth} />
          <p className="text-sm text-muted">
            Behåll den här fliken öppen så behåller du din plats.
          </p>
        </Centered>
      );
    case 'admitted':
      return (
        <Centered>
          <Spinner size="lg" />
          <p role="status">Du är insläppt. Tar dig till kartan…</p>
        </Centered>
      );
    case 'sales_closed':
      return (
        <Centered>
          <Alert tone="info">Försäljningen för det här evenemanget är stängd.</Alert>
        </Centered>
      );
    case 'not_found':
      return (
        <Centered>
          <Alert tone="warning">Din plats i kön har gått ut.</Alert>
          <Button onClick={onRejoin}>Ställ dig i kön igen</Button>
        </Centered>
      );
  }
}

export function QueueScreen({
  eventId,
  onRejoin,
}: {
  eventId: string;
  onRejoin: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { status, isJoining, error } = useQueueAdmission(eventId);
  const isAdmitted = status?.status === 'admitted';
  // Efter att kötoken löpt ut svarar servern 401/404 i stället för `not_found`; pollingen
  // behåller då gamla `waiting`-data. Det är "platsen har gått ut", inte en tappad anslutning.
  const isTokenExpired =
    error instanceof ApiError && (error.status === 401 || error.status === 404);

  useEffect(() => {
    if (isAdmitted) {
      toast.success('Du är insläppt. Välj dina platser.');
      void navigate(`/events/${eventId}/seatmap`, { replace: true });
    }
  }, [isAdmitted, eventId, navigate]);

  if (isTokenExpired) {
    return (
      <QueueState
        status={{ status: 'not_found' }}
        hasConnectionError={false}
        onRejoin={onRejoin}
      />
    );
  }
  if (status === undefined) {
    return error === undefined || isJoining ? (
      <Centered>
        <Spinner size="lg" />
        <p role="status">Ansluter till kön…</p>
      </Centered>
    ) : (
      <ErrorState message="Kunde inte ställa dig i kön." onRetry={onRejoin} />
    );
  }
  return (
    <QueueState status={status} hasConnectionError={error !== undefined} onRejoin={onRejoin} />
  );
}
