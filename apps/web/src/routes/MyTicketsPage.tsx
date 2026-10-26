/**
 * "Mina biljetter" (docs/plan.md "Klienter": "mina biljetter med
 * QR-koder" is the one thing that still works offline — see
 * lib/service-worker-registration.ts for the caching side of that).
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import type { JSX } from 'react';
import { listMyTickets, type MyTicketOrder } from '../lib/api-client.js';
import { clearMyTicketsOfflineCache } from '../lib/clear-offline-cache.js';
import { isAuth0Configured } from '../lib/auth-provider.js';

export function MyTicketsPage(): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect, getAccessTokenSilently, logout } =
    useAuth0();
  const ordersQuery = useQuery({
    queryKey: ['my-tickets'],
    queryFn: async () => {
      const accessToken = await getAccessTokenSilently();
      if (accessToken === undefined) {
        throw new Error('Could not get an access token');
      }
      return listMyTickets(accessToken);
    },
    enabled: isAuthenticated,
    // Betalningen bekräftas asynkront (webhook → outbox → RabbitMQ →
    // booking-apis konsument, se e2e.yml) efter att webbläsaren redan
    // navigerat hit — utan polling fastnar sidan på "pending" för gott,
    // även om ordern blir "paid" i databasen sekunder senare. Hittat
    // live: e2e-testet fastnade alltid här, oavsett hur snabbt
    // betalningspipen faktiskt var, eftersom sidan bara hämtade en gång.
    refetchInterval: (query) =>
      query.state.data?.orders.some((order) => order.status === 'pending') === true
        ? 2000
        : false,
  });

  if (!isAuth0Configured) {
    // Without this check, useAuth0()'s isLoading stays true forever
    // outside a provider — this would otherwise look like an infinite
    // spinner instead of the configuration error it actually is.
    return <p role="alert">Inloggning är inte konfigurerad.</p>;
  }
  if (isLoading) {
    return <p>Laddar…</p>;
  }
  if (!isAuthenticated) {
    return <LoginPrompt loginWithRedirect={loginWithRedirect} />;
  }
  if (ordersQuery.isPending) {
    return <p>Laddar dina biljetter…</p>;
  }
  if (ordersQuery.isError) {
    return <p role="alert">Kunde inte hämta dina biljetter.</p>;
  }

  return <MyTicketsList orders={ordersQuery.data.orders} logout={logout} />;
}

function LoginPrompt({
  loginWithRedirect,
}: {
  loginWithRedirect: (options: { appState: { returnTo: string } }) => Promise<void>;
}): JSX.Element {
  return (
    <section>
      <h1>Mina biljetter</h1>
      <button
        type="button"
        onClick={() =>
          void loginWithRedirect({ appState: { returnTo: window.location.pathname } })
        }
      >
        Logga in
      </button>
    </section>
  );
}

function MyTicketsList({
  orders,
  logout,
}: {
  orders: readonly MyTicketOrder[];
  logout: (options: { logoutParams: { returnTo: string } }) => Promise<void>;
}): JSX.Element {
  function handleLogout(): void {
    void clearMyTicketsOfflineCache().then(() =>
      logout({ logoutParams: { returnTo: window.location.origin } }),
    );
  }

  return (
    <section>
      <h1>Mina biljetter</h1>
      <button type="button" onClick={handleLogout}>
        Logga ut
      </button>
      {orders.length === 0 ? (
        <p>Du har inga biljetter än.</p>
      ) : (
        orders.map((order) => <OrderCard key={order.orderId} order={order} />)
      )}
    </section>
  );
}

function OrderCard({ order }: { order: MyTicketOrder }): JSX.Element {
  return (
    <article>
      <h2>{order.eventTitle}</h2>
      <p>Status: {order.status}</p>
      <ul>
        {order.tickets.map((ticket) => (
          <li key={ticket.ticketId}>
            Rad {ticket.row}, plats {ticket.number} — {ticket.status}
            {ticket.status === 'valid' ? <QRCodeSVG value={ticket.qrToken} size={96} /> : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
