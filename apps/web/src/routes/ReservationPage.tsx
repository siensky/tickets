/**
 * Reservation med nedräkning + checkout (docs/plan.md "Betalning":
 * "Inloggning krävs först vid betalning, efter reservation" — login
 * only happens here, never for the queue/seatmap flow).
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { createCheckout, getReservation, type ReservationView } from '../lib/api-client.js';
import { getStoredQueueToken } from '../lib/queue-token-storage.js';
import { isAuth0Configured } from '../lib/auth-provider.js';
import { Countdown } from '../components/Countdown.js';

const RESERVATION_POLL_MS = 3000;

function useReservationCheckout(
  eventId: string,
  reservationId: string,
  queueToken: string | undefined,
) {
  const { getAccessTokenSilently } = useAuth0();
  // One key per reservation, not per click — a retry of the SAME
  // checkout attempt must replay, not collide with "en aktiv Checkout
  // per kötoken" (docs/plan.md "Betalning").
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const reservationQuery = useQuery({
    queryKey: ['reservation', eventId, reservationId],
    queryFn: () => getReservation(eventId, reservationId, queueToken ?? ''),
    enabled: eventId !== '' && reservationId !== '' && queueToken !== undefined,
    refetchInterval: (query) =>
      query.state.data?.status === 'active' ? RESERVATION_POLL_MS : false,
  });

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      const accessToken = await getAccessTokenSilently();
      if (accessToken === undefined) {
        throw new Error('Could not get an access token');
      }
      return createCheckout(
        eventId,
        reservationId,
        queueToken ?? '',
        accessToken,
        idempotencyKeyRef.current,
      );
    },
    onSuccess: (result) => {
      window.location.href = result.checkoutUrl;
    },
  });

  return { reservationQuery, checkoutMutation };
}

export function ReservationPage(): JSX.Element {
  const { eventId: rawEventId, reservationId: rawReservationId } = useParams<{
    eventId: string;
    reservationId: string;
  }>();
  const eventId = rawEventId ?? '';
  const reservationId = rawReservationId ?? '';
  const queueToken = getStoredQueueToken(eventId);
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  const { reservationQuery, checkoutMutation } = useReservationCheckout(
    eventId,
    reservationId,
    queueToken,
  );

  if (rawEventId === undefined || rawReservationId === undefined || queueToken === undefined) {
    return (
      <p role="alert">Ingen giltig reservation hittades. Gå tillbaka till arenakartan.</p>
    );
  }
  if (reservationQuery.isPending) {
    return <p>Laddar reservation…</p>;
  }
  if (reservationQuery.isError) {
    return <p role="alert">Kunde inte hämta reservationen.</p>;
  }

  const reservation = reservationQuery.data;
  if (reservation.status !== 'active') {
    return <ReservationOutcome status={reservation.status} />;
  }
  if (!isAuth0Configured) {
    return <p role="alert">Inloggning är inte konfigurerad — kan inte gå till betalning.</p>;
  }

  return (
    <ActiveReservation
      reservation={reservation}
      isAuthenticated={isAuthenticated}
      isLoading={isLoading}
      loginWithRedirect={loginWithRedirect}
      checkoutMutation={checkoutMutation}
    />
  );
}

interface ActiveReservationProps {
  reservation: ReservationView;
  isAuthenticated: boolean;
  isLoading: boolean;
  loginWithRedirect: (options?: { appState: { returnTo: string } }) => Promise<void>;
  checkoutMutation: {
    mutate: () => void;
    isPending: boolean;
    isError: boolean;
    error: Error | null;
  };
}

function ActiveReservation({
  reservation,
  isAuthenticated,
  isLoading,
  loginWithRedirect,
  checkoutMutation,
}: ActiveReservationProps): JSX.Element {
  function handlePay(): void {
    if (!isAuthenticated) {
      void loginWithRedirect({ appState: { returnTo: window.location.pathname } });
      return;
    }
    checkoutMutation.mutate();
  }

  return (
    <section>
      <h1>Din reservation</h1>
      <p>{reservation.seatIds.length} stol(ar) reserverade.</p>
      <p>
        Tid kvar: <Countdown expiresAt={reservation.expiresAt} />
      </p>
      <button
        type="button"
        disabled={isLoading || checkoutMutation.isPending}
        onClick={handlePay}
      >
        {isAuthenticated ? 'Gå till betalning' : 'Logga in och betala'}
      </button>
      {checkoutMutation.isError && checkoutMutation.error !== null ? (
        <p role="alert">Kunde inte starta betalningen: {checkoutMutation.error.message}</p>
      ) : null}
    </section>
  );
}

function ReservationOutcome({ status }: { status: string }): JSX.Element {
  if (status === 'pending_payment') {
    return <p>Betalning pågår…</p>;
  }
  if (status === 'converted') {
    return <p>Köpet är klart! Se dina biljetter under &quot;Mina biljetter&quot;.</p>;
  }
  return <p role="alert">Reservationen är inte längre aktiv ({status}).</p>;
}
