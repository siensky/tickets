/**
 * Hämtar reservationen (pollas var 3:e sekund medan den är aktiv) och startar checkout.
 * Nyckeln för checkout skapas EN gång per sida, inte per klick: ett nytt försök av samma
 * betalning ska spelas upp av servern, inte kollidera med "en aktiv Checkout per kötoken"
 * (docs/plan.md "Betalning").
 */
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRef } from 'react';
import {
  createCheckout,
  getReservation,
  type CheckoutResult,
  type ReservationView,
} from '../../lib/api-client.js';
import { useAccessToken } from '../../lib/use-access-token.js';

const RESERVATION_POLL_MS = 3000;

export function useReservationCheckout(
  eventId: string,
  reservationId: string,
  queueToken: string | undefined,
): {
  reservationQuery: UseQueryResult<ReservationView>;
  checkoutMutation: UseMutationResult<CheckoutResult, Error, void>;
} {
  const getAccessToken = useAccessToken();
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
      const accessToken = await getAccessToken();
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
