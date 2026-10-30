/**
 * "Mina biljetter" (docs/plan.md "Klienter": QR-koderna fungerar offline via service workern,
 * se lib/service-worker-registration.ts). Pollas medan någon order väntar på betalning.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Ticket, WifiOff } from 'lucide-react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useIsOnline } from '../components/layout/OfflineBanner.js';
import { Alert } from '../components/ui/Alert.js';
import { Badge } from '../components/ui/Badge.js';
import { Button, buttonClass } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Skeleton } from '../components/ui/Skeleton.js';
import { TicketCard } from '../features/tickets/TicketCard.js';
import { listMyTickets, type MyTicketOrder } from '../lib/api-client.js';
import { isAuth0Configured } from '../lib/auth-provider.js';
import { useAccessToken } from '../lib/use-access-token.js';

function Page({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  const isOnline = useIsOnline();
  return (
    <Container className="flex max-w-3xl flex-col gap-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl sm:text-3xl">Mina biljetter</h1>
        {isOnline ? null : (
          <Badge tone="neutral">
            <WifiOff size={12} strokeWidth={1.75} aria-hidden="true" /> Offline
          </Badge>
        )}
      </div>
      {children}
    </Container>
  );
}

function LoginPrompt({ onLogin }: { onLogin: () => void }): JSX.Element {
  return (
    <EmptyState icon={Ticket} title="Logga in för att se dina biljetter">
      <Button className="mt-2" onClick={onLogin}>
        Logga in
      </Button>
    </EmptyState>
  );
}

function TicketsContent({ orders }: { orders: readonly MyTicketOrder[] }): JSX.Element {
  if (orders.length === 0) {
    return (
      <EmptyState icon={Ticket} title="Du har inga biljetter än">
        Hitta ditt nästa evenemang.
        <div className="mt-4">
          <Link to="/" className={buttonClass('primary')}>
            Utforska evenemang
          </Link>
        </div>
      </EmptyState>
    );
  }
  return (
    <>
      {orders.map((order) => (
        <TicketCard key={order.orderId} order={order} />
      ))}
    </>
  );
}

function useMyTicketsQuery(isEnabled: boolean): UseQueryResult<{ orders: MyTicketOrder[] }> {
  const getAccessToken = useAccessToken();
  return useQuery({
    queryKey: ['my-tickets'],
    queryFn: async () => listMyTickets(await getAccessToken()),
    enabled: isEnabled,
    // Betalningen bekräftas asynkront (webhook → outbox → RabbitMQ → booking-apis konsument)
    // efter att webbläsaren navigerat hit; utan polling fastnar en väntande order på "pending".
    refetchInterval: (query) =>
      query.state.data?.orders.some((order) => order.status === 'pending') === true
        ? 2000
        : false,
  });
}

export function MyTicketsPage(): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  const ordersQuery = useMyTicketsQuery(isAuthenticated);

  if (!isAuth0Configured) {
    // Utan provider står `isLoading` från useAuth0() för evigt: visa konfigurationsfelet i stället.
    return (
      <Page>
        <Alert tone="error">Inloggning är inte konfigurerad.</Alert>
      </Page>
    );
  }
  if (
    isLoading ||
    (isAuthenticated && ordersQuery.data === undefined && !ordersQuery.isError)
  ) {
    return (
      <Page>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }
  if (!isAuthenticated) {
    return (
      <Page>
        <LoginPrompt
          onLogin={() =>
            void loginWithRedirect({ appState: { returnTo: window.location.pathname } })
          }
        />
      </Page>
    );
  }
  if (ordersQuery.isError || ordersQuery.data === undefined) {
    return (
      <Page>
        <ErrorState
          message="Kunde inte hämta dina biljetter."
          onRetry={() => void ordersQuery.refetch()}
        />
      </Page>
    );
  }
  return (
    <Page>
      <TicketsContent orders={ordersQuery.data.orders} />
    </Page>
  );
}
