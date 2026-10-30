/**
 * Checkout (docs/plan.md 7.11 F, "Betalning": inloggning krävs först här, efter reservationen;
 * köflödet är anonymt). Allt som visas kommer från serverns reservation. Går reservationen ut
 * (serverns status eller nedräkningen) visas modalen och användaren skickas tillbaka till kartan.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRemainingSeconds } from '../components/Countdown.js';
import { Alert } from '../components/ui/Alert.js';
import { buttonClass } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Skeleton } from '../components/ui/Skeleton.js';
import { CheckoutReview } from '../features/checkout/CheckoutReview.js';
import { CheckoutSteps } from '../features/checkout/CheckoutSteps.js';
import { ReservationExpiredModal } from '../features/checkout/ReservationExpiredModal.js';
import { useReservationCheckout } from '../features/checkout/use-reservation-checkout.js';
import { getEvent, type ReservationView } from '../lib/api-client.js';
import { isAuth0Configured } from '../lib/auth-provider.js';
import { getStoredQueueToken } from '../lib/queue-token-storage.js';

function Page({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <Container className="flex flex-col gap-6 py-8">
      <h1 className="text-2xl sm:text-3xl">Granska och betala</h1>
      {children}
    </Container>
  );
}

function ReservationOutcome({ status }: { status: ReservationView['status'] }): JSX.Element {
  if (status === 'pending_payment') {
    return <Alert tone="info">Betalning pågår. Vi väntar på bekräftelsen från Stripe.</Alert>;
  }
  if (status === 'converted') {
    return (
      <Alert tone="success">
        Köpet är klart.{' '}
        <Link to="/my-tickets" className="link">
          Se dina biljetter under Mina biljetter
        </Link>
        .
      </Alert>
    );
  }
  return <Alert tone="warning">Reservationen är inte längre aktiv.</Alert>;
}

function ActiveCheckout({
  eventId,
  reservation,
  checkout,
}: {
  eventId: string;
  reservation: ReservationView;
  checkout: ReturnType<typeof useReservationCheckout>['checkoutMutation'];
}): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
  });
  const isExpired = useRemainingSeconds(reservation.expiresAt) === 0;

  function handlePay(): void {
    if (!isAuthenticated) {
      void loginWithRedirect({ appState: { returnTo: window.location.pathname } });
      return;
    }
    checkout.mutate();
  }

  return (
    <>
      <CheckoutReview
        reservation={reservation}
        eventTitle={eventQuery.data?.title ?? ''}
        payLabel={isAuthenticated ? 'Betala med Stripe' : 'Logga in och betala'}
        isPaying={isLoading || checkout.isPending}
        errorMessage={
          checkout.isError
            ? `Kunde inte starta betalningen: ${checkout.error.message}`
            : undefined
        }
        onPay={handlePay}
      />
      <ReservationExpiredModal open={isExpired} eventId={eventId} />
    </>
  );
}

function MissingReservation({ eventId }: { eventId: string }): JSX.Element {
  return (
    <Page>
      <Alert tone="warning">Ingen giltig reservation hittades.</Alert>
      <Link to={`/events/${eventId}`} className={buttonClass('secondary')}>
        Tillbaka till evenemanget
      </Link>
    </Page>
  );
}

function ReservationContent({
  eventId,
  reservation,
  checkout,
}: {
  eventId: string;
  reservation: ReservationView;
  checkout: ReturnType<typeof useReservationCheckout>['checkoutMutation'];
}): JSX.Element {
  if (reservation.status === 'active') {
    return <ActiveCheckout eventId={eventId} reservation={reservation} checkout={checkout} />;
  }
  if (reservation.status === 'expired' || reservation.status === 'cancelled') {
    return <ReservationExpiredModal open eventId={eventId} />;
  }
  return <ReservationOutcome status={reservation.status} />;
}

function ReservationLoadState({
  isError,
  onRetry,
}: {
  isError: boolean;
  onRetry: () => void;
}): JSX.Element {
  return (
    <Page>
      {isError ? (
        <ErrorState message="Kunde inte hämta reservationen." onRetry={onRetry} />
      ) : (
        <Skeleton className="h-96 w-full" />
      )}
    </Page>
  );
}

export function ReservationPage(): JSX.Element {
  const { eventId = '', reservationId = '' } = useParams<{
    eventId: string;
    reservationId: string;
  }>();
  const queueToken = getStoredQueueToken(eventId);
  const { reservationQuery, checkoutMutation } = useReservationCheckout(
    eventId,
    reservationId,
    queueToken,
  );

  if (queueToken === undefined) {
    return <MissingReservation eventId={eventId} />;
  }
  if (!isAuth0Configured) {
    return (
      <Page>
        <Alert tone="error">
          Inloggning är inte konfigurerad, så betalning går inte att starta.
        </Alert>
      </Page>
    );
  }
  if (reservationQuery.data === undefined) {
    return (
      <ReservationLoadState
        isError={reservationQuery.isError}
        onRetry={() => void reservationQuery.refetch()}
      />
    );
  }
  return (
    <Page>
      <CheckoutSteps current="Granska" />
      <ReservationContent
        eventId={eventId}
        reservation={reservationQuery.data}
        checkout={checkoutMutation}
      />
    </Page>
  );
}
