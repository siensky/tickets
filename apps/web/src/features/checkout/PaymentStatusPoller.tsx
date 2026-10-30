/**
 * Verifierar betalningen (docs/plan.md 7.11 F, E6): pollar `GET /events/:eventId/orders/:orderId`
 * var 2:a sekund i högst 60 s. Visar ALDRIG "klart" bara för att användaren kom tillbaka från
 * Stripe; bara serverns `paid` räknas. Utan `paid` efter 60 s: "Vi har inte fått bekräftelsen än".
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '../../components/ui/Alert.js';
import { buttonClass } from '../../components/ui/Button.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Spinner } from '../../components/ui/Spinner.js';
import { getOrder, type OrderView } from '../../lib/api-client.js';
import { useAccessToken } from '../../lib/use-access-token.js';
import { OrderConfirmation } from './OrderConfirmation.js';

export const ORDER_POLL_MS = 2000;
export const ORDER_POLL_TIMEOUT_MS = 60_000;

function useOrderPolling(
  eventId: string,
  orderId: string,
): {
  order: OrderView | undefined;
  isError: boolean;
  refetch: () => void;
  timedOut: boolean;
} {
  const getAccessToken = useAccessToken();
  const startedAt = useRef(Date.now());
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), ORDER_POLL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const query = useQuery({
    queryKey: ['order', eventId, orderId],
    queryFn: async () => getOrder(eventId, orderId, await getAccessToken()),
    refetchInterval: (state) =>
      state.state.data?.status === 'pending' &&
      Date.now() - startedAt.current < ORDER_POLL_TIMEOUT_MS
        ? ORDER_POLL_MS
        : false,
  });
  return {
    order: query.data,
    isError: query.isError,
    refetch: () => void query.refetch(),
    timedOut,
  };
}

function Pending(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <Spinner size="lg" />
      <p role="status" className="text-lg">
        Bekräftar betalningen…
      </p>
      <p className="text-muted">Det kan ta några sekunder. Stäng inte sidan.</p>
    </div>
  );
}

function TicketsLink(): JSX.Element {
  return (
    <Link to="/my-tickets" className={buttonClass('secondary')}>
      Gå till Mina biljetter
    </Link>
  );
}

function OrderOutcome({
  order,
  timedOut,
}: {
  order: OrderView;
  timedOut: boolean;
}): JSX.Element {
  switch (order.status) {
    case 'paid':
      return <OrderConfirmation order={order} />;
    case 'refunded':
      return (
        <div className="flex flex-col items-start gap-4">
          <Alert tone="warning">
            Betalningen kom efter att reservationen gått ut och har återbetalats.
          </Alert>
          <TicketsLink />
        </div>
      );
    case 'cancelled':
      return (
        <div className="flex flex-col items-start gap-4">
          <Alert tone="warning">Ordern avbröts.</Alert>
          <TicketsLink />
        </div>
      );
    case 'pending':
      return timedOut ? (
        <div className="flex flex-col items-start gap-4">
          <Alert tone="info">
            Vi har inte fått bekräftelsen än. Din betalning kan fortfarande gå igenom. Titta
            under Mina biljetter om en stund.
          </Alert>
          <TicketsLink />
        </div>
      ) : (
        <Pending />
      );
  }
}

export function PaymentStatusPoller({
  eventId,
  orderId,
  onPaid,
}: {
  eventId: string;
  orderId: string;
  onPaid?: () => void;
}): JSX.Element {
  const { order, isError, refetch, timedOut } = useOrderPolling(eventId, orderId);
  const isPaid = order?.status === 'paid';
  useEffect(() => {
    if (isPaid) {
      onPaid?.();
    }
  }, [isPaid, onPaid]);

  if (isError) {
    return <ErrorState message="Kunde inte kontrollera betalningen." onRetry={refetch} />;
  }
  if (order === undefined) {
    return <Pending />;
  }
  return <OrderOutcome order={order} timedOut={timedOut} />;
}
