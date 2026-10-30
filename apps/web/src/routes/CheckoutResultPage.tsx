/**
 * `/checkout/success` och `/checkout/cancel` — dit Stripe skickar tillbaka webbläsaren
 * (docs/plan.md 7.11 F). Bekräftelsesidan litar inte på återkomsten: den läser
 * `event_id`/`order_id` ur queryn och väntar in `paid` från backend. Avbrytsidan kollar om
 * reservationen fortfarande är aktiv och erbjuder i så fall "Försök igen".
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from '@tanstack/react-query';
import { useState, type JSX, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui/Alert.js';
import { Button, buttonClass } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { Spinner } from '../components/ui/Spinner.js';
import { CheckoutSteps } from '../features/checkout/CheckoutSteps.js';
import { PaymentStatusPoller } from '../features/checkout/PaymentStatusPoller.js';
import { getReservation } from '../lib/api-client.js';
import { isAuth0Configured } from '../lib/auth-provider.js';
import { getStoredQueueToken } from '../lib/queue-token-storage.js';

function Shell({
  children,
  step,
}: {
  children: ReactNode;
  step?: 'Betala' | 'Klart';
}): JSX.Element {
  return (
    <Container className="flex max-w-3xl flex-col gap-6 py-8">
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

export function CheckoutCancelPage(): JSX.Element {
  const [params] = useSearchParams();
  const eventId = params.get('event_id') ?? '';
  const reservationId = params.get('reservation_id') ?? '';
  const queueToken = getStoredQueueToken(eventId);
  const reservationQuery = useQuery({
    queryKey: ['reservation', eventId, reservationId],
    queryFn: () => getReservation(eventId, reservationId, queueToken ?? ''),
    enabled: eventId !== '' && reservationId !== '' && queueToken !== undefined,
  });
  const isActive = reservationQuery.data?.status === 'active';

  return (
    <Shell>
      <h1 className="text-2xl sm:text-3xl">Betalningen avbröts</h1>
      <Alert tone="info">Ingen betalning har gjorts.</Alert>
      {isActive ? (
        <Link
          to={`/events/${eventId}/reservations/${reservationId}`}
          className={buttonClass('primary', 'lg', 'self-start')}
        >
          Försök igen
        </Link>
      ) : (
        <Link to="/" className={buttonClass('secondary', 'md', 'self-start')}>
          Till evenemang
        </Link>
      )}
    </Shell>
  );
}
