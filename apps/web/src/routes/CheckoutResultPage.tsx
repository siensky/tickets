/**
 * `/checkout/success` och `/checkout/cancel` — dit Stripe skickar tillbaka webbläsaren
 * (docs/plan.md 7.11 F). Bekräftelsesidan litar inte på återkomsten: den läser
 * `event_id`/`order_id` ur queryn och väntar in `paid` från backend. Avbrytsidan avbryter bokningen
 * direkt, så att stolarna släpps och en ny bokning fungerar på en gång.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui/Alert.js';
import { BackLink } from '../components/ui/BackLink.js';
import { Button, buttonClass } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { Spinner } from '../components/ui/Spinner.js';
import { CheckoutSteps } from '../features/checkout/CheckoutSteps.js';
import { PaymentStatusPoller } from '../features/checkout/PaymentStatusPoller.js';
import { useEventContext } from '../features/analytics/use-event-context.js';
import { useTrackOnce } from '../features/analytics/use-track-once.js';
import { ApiError, cancelReservation } from '../lib/api-client.js';
import { isAuth0Configured } from '../lib/auth-provider.js';
import { getStoredQueueToken } from '../lib/queue-token-storage.js';
import { clearLastReservationId } from '../lib/reservation-storage.js';

function Shell({
  children,
  step,
}: {
  children: ReactNode;
  step?: 'Betala' | 'Klart';
}): JSX.Element {
  return (
    <Container className="ph-no-capture flex max-w-3xl flex-col gap-6 py-8">
      {step === undefined ? null : <CheckoutSteps current={step} />}
      {children}
    </Container>
  );
}

function SuccessContent({
  eventId,
  orderId,
  onPaid,
}: {
  eventId: string;
  orderId: string;
  onPaid: () => void;
}): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  if (isLoading) {
    return <Spinner size="lg" />;
  }
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Alert tone="info">Logga in för att se din bekräftelse.</Alert>
        <Button
          onClick={() =>
            void loginWithRedirect({
              appState: { returnTo: window.location.pathname + window.location.search },
            })
          }
        >
          Logga in
        </Button>
      </div>
    );
  }
  return <PaymentStatusPoller eventId={eventId} orderId={orderId} onPaid={onPaid} />;
}

export function CheckoutSuccessPage(): JSX.Element {
  const [params] = useSearchParams();
  const eventId = params.get('event_id');
  const orderId = params.get('order_id');
  const [isPaid, setIsPaid] = useState(false);
  return (
    <Shell step={isPaid ? 'Klart' : 'Betala'}>
      <h1 className="text-2xl sm:text-3xl">Betalning</h1>
      {eventId === null || orderId === null || !isAuth0Configured ? (
        <div className="flex flex-col items-start gap-4">
          <Alert tone="warning">
            Vi kunde inte hitta din order. Kontrollera Mina biljetter.
          </Alert>
          <Link to="/my-tickets" className={buttonClass('secondary')}>
            Gå till Mina biljetter
          </Link>
        </div>
      ) : (
        <SuccessContent eventId={eventId} orderId={orderId} onPaid={() => setIsPaid(true)} />
      )}
    </Shell>
  );
}

/**
 * Avbryter bokningen så fort Stripe skickat tillbaka kunden: servern låter sessionen gå ut hos Stripe och
 * släpper stolarna (DELETE är idempotent, så en dubbel körning i StrictMode gör inget). Annars står
 * stolarna kvar som "betalning pågår" och blockerar en ny bokning tills frysningen löpt ut.
 */
type CancelOutcomeState = 'cancelling' | 'released' | 'paying' | 'failed' | 'nothing';

function useCancelOnReturn(
  eventId: string,
  reservationId: string,
): { outcome: CancelOutcomeState; retry: () => void } {
  const queueToken = getStoredQueueToken(eventId);
  const canCancel = eventId !== '' && reservationId !== '' && queueToken !== undefined;
  const mutation = useMutation({
    mutationFn: () => cancelReservation(eventId, reservationId, queueToken ?? ''),
    onSuccess: () => clearLastReservationId(eventId, reservationId),
  });
  const { mutate } = mutation;
  useEffect(() => {
    if (canCancel) {
      mutate();
    }
  }, [canCancel, mutate]);
  const retry = (): void => mutate();
  if (!canCancel) {
    return { outcome: 'nothing', retry };
  }
  if (mutation.isSuccess) {
    return { outcome: 'released', retry };
  }
  if (mutation.isError) {
    const error = mutation.error;
    const isPaid = error instanceof ApiError && error.code === 'ACTIVE_RESERVATION_EXISTS';
    return { outcome: isPaid ? 'paying' : 'failed', retry };
  }
  return { outcome: 'cancelling', retry };
}

function PaymentAlreadyMade(): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4">
      <Alert tone="warning">
        Betalningen verkar redan ha gått igenom. Titta i Mina biljetter om en liten stund.
      </Alert>
      <Link to="/my-tickets" className={buttonClass('secondary', 'md', 'self-start')}>
        Gå till Mina biljetter
      </Link>
    </div>
  );
}

function CancelFailed({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-4">
      <Alert tone="warning">
        Vi kunde inte avbryta bokningen just nu. Försök igen om en liten stund.
      </Alert>
      <Button onClick={onRetry}>Försök igen</Button>
    </div>
  );
}

function CancelOutcome({
  eventId,
  outcome,
  onRetry,
}: {
  eventId: string;
  outcome: CancelOutcomeState;
  onRetry: () => void;
}): JSX.Element {
  if (outcome === 'cancelling') {
    return <Spinner size="lg" />;
  }
  if (outcome === 'paying') {
    return <PaymentAlreadyMade />;
  }
  if (outcome === 'failed') {
    return <CancelFailed onRetry={onRetry} />;
  }
  return (
    <div className="flex flex-col items-start gap-4">
      <Alert tone="info">
        {outcome === 'released'
          ? 'Ingen betalning har gjorts. Platserna är släppta, så du kan välja igen.'
          : 'Ingen betalning har gjorts.'}
      </Alert>
      {eventId === '' ? (
        <Link to="/" className={buttonClass('secondary', 'md', 'self-start')}>
          Till evenemang
        </Link>
      ) : (
        <Link
          to={`/events/${eventId}/queue`}
          className={buttonClass('primary', 'lg', 'self-start')}
        >
          Välj platser igen
        </Link>
      )}
    </div>
  );
}

export function CheckoutCancelPage(): JSX.Element {
  const [params] = useSearchParams();
  const eventId = params.get('event_id') ?? '';
  const reservationId = params.get('reservation_id') ?? '';
  const { outcome, retry } = useCancelOnReturn(eventId, reservationId);
  const eventContext = useEventContext(eventId);
  useTrackOnce(
    'checkout_returned',
    eventContext === undefined ? undefined : { ...eventContext, status: 'aborted' },
  );

  return (
    <Shell>
      {eventId === '' ? null : <BackLink to={`/events/${eventId}`}>Till evenemanget</BackLink>}
      <h1 className="text-2xl sm:text-3xl">Betalningen avbröts</h1>
      <CancelOutcome eventId={eventId} outcome={outcome} onRetry={retry} />
    </Shell>
  );
}
