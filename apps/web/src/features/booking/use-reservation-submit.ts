/**
 * Skapar reservationen och navigerar till checkout (docs/plan.md "Idempotens"). Nyckeln är
 * knuten till det exakta stolsurvalet: ett nytt försök med SAMMA stolar återanvänder den (så
 * servern kan spela upp svaret), ett annat urval får en ny. Annars avvisar servern det nya
 * urvalet som en konflikt mot den gamla nyckelns förfrågan.
 */
import { useMutation } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, createReservation } from '../../lib/api-client.js';

function describeError(error: Error | null): string | undefined {
  if (error === null) {
    return undefined;
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
  const selectionKey = [...seatIds].sort().join(',');
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [selectionKey]);

  const mutation = useMutation({
    mutationFn: () => createReservation(eventId, queueToken ?? '', seatIds, idempotencyKey),
    onSuccess: (result) => navigate(`/events/${eventId}/reservations/${result.reservationId}`),
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
