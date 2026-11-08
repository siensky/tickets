/**
 * Skapar reservationen och navigerar till checkout (docs/plan.md "Idempotens"). Nyckeln är
 * knuten till det exakta stolsurvalet: ett nytt försök med SAMMA stolar återanvänder den (så
 * servern kan spela upp svaret), ett annat urval får en ny. Annars avvisar servern det nya
 * urvalet som en konflikt mot den gamla nyckelns förfrågan.
 *
 * 503 (alla databasanslutningar upptagna, bara i försäljningens värsta topp) försöks om med samma
 * nyckel, så att servern kan spela upp en reservation som hann sparas i stället för att skapa en till.
 * Fallgrop: `IDEMPOTENCY_CONFLICT` efter ett 503 betyder antingen att servern inte hann städa nyckeln
 * (inget sparat) eller att reservationen sparades men inte hann markeras klar (den finns). Klienten kan
 * inte skilja dem åt, så meddelandet är inte "platsen är tagen" och lovar ingetdera.
 * Omförsöken avbryts när komponenten lämnas, så att ingen reservation skapas för en sida som är stängd.
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { track } from '../../lib/analytics.js';
import { ApiError, createReservation } from '../../lib/api-client.js';
import { storeLastReservationId } from '../../lib/reservation-storage.js';
import { retryWhileBusy } from '../../lib/retry-while-busy.js';
import { useEventContext } from '../analytics/use-event-context.js';

function describeError(error: Error | null): string | undefined {
  if (error === null) {
    return undefined;
  }
  if (error instanceof ApiError && error.code === 'ACTIVE_RESERVATION_EXISTS') {
    return 'Du har en bokning som väntar på betalning, kanske i en annan flik. Slutför eller avbryt den där, eller vänta några minuter.';
  }
  if (error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT') {
    return 'Det är mycket tryck just nu och vi kunde inte bekräfta reservationen. Vänta några minuter och försök igen.';
  }
  if (error instanceof ApiError && error.status === 409) {
    return 'En eller flera av platserna hann bli upptagna. Välj andra platser.';
  }
  return `Kunde inte reservera: ${error.message}`;
}

export function useReservationSubmit(
  eventId: string,
  queueToken: string | undefined,
  seatIds: readonly string[],
): { reserve: () => void; isReserving: boolean; errorMessage: string | undefined } {
  const navigate = useNavigate();
  const eventContext = useEventContext(eventId);
  const selectionKey = [...seatIds].sort().join(',');
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [selectionKey]);
  const isUnmounted = useRef(false);
  useEffect(() => {
    isUnmounted.current = false;
    return () => {
      isUnmounted.current = true;
    };
  }, []);

  const mutation = useMutation({
    mutationFn: () =>
      retryWhileBusy(
        () => createReservation(eventId, queueToken ?? '', seatIds, idempotencyKey),
        { isCancelled: () => isUnmounted.current },
      ),
    onSuccess: (result) => {
      storeLastReservationId(eventId, result.reservationId);
      if (eventContext !== undefined) {
        track('reservation_created', { ...eventContext, seat_count: seatIds.length });
      }
      return navigate(`/events/${eventId}/reservations/${result.reservationId}`);
    },
  });

  return {
    reserve: () => {
      if (seatIds.length > 0 && queueToken !== undefined) {
        mutation.mutate();
      }
    },
    isReserving: mutation.isPending,
    errorMessage: describeError(mutation.error),
  };
}
