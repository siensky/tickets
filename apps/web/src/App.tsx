import { lazy, Suspense, type JSX } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { Container } from './components/ui/Container.js';
import { Skeleton } from './components/ui/Skeleton.js';
import { HomePage } from './routes/HomePage.js';

// Alla sidor utom startsidan laddas vid behov (docs/plan.md 7.11 Lighthouse-mål): kartan drar in
// pan/zoom, biljetterna QR-biblioteket och checkout Auth0-flödet, och ingen av dem behövs för
// att visa startsidan.
const EventPage = lazy(() =>
  import('./routes/EventPage.js').then((m) => ({ default: m.EventPage })),
);
const QueuePage = lazy(() =>
  import('./routes/QueuePage.js').then((m) => ({ default: m.QueuePage })),
);
const SeatmapPage = lazy(() =>
  import('./routes/SeatmapPage.js').then((m) => ({ default: m.SeatmapPage })),
);
const ReservationPage = lazy(() =>
  import('./routes/ReservationPage.js').then((m) => ({ default: m.ReservationPage })),
);
const MyTicketsPage = lazy(() =>
  import('./routes/MyTicketsPage.js').then((m) => ({ default: m.MyTicketsPage })),
);
const CheckoutSuccessPage = lazy(() =>
  import('./routes/CheckoutResultPage.js').then((m) => ({ default: m.CheckoutSuccessPage })),
);
const CheckoutCancelPage = lazy(() =>
  import('./routes/CheckoutResultPage.js').then((m) => ({ default: m.CheckoutCancelPage })),
);

function RouteFallback(): JSX.Element {
  return (
    <Container className="flex flex-col gap-4 py-8">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-80 w-full" />
    </Container>
  );
}

/**
 * Root component (docs/plan.md "Domän och användarflöde"): välj evenemang → väntrum →
 * arenakarta → reservation → (inloggning +) betalning, plus "mina biljetter" oberoende av
 * flödet. `/events/:eventId/queue` är väntrummet, utflyttat ur arenakartan (7.11 C).
 */
export function App(): JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/events/:eventId" element={<EventPage />} />
          <Route path="/events/:eventId/queue" element={<QueuePage />} />
          <Route path="/events/:eventId/seatmap" element={<SeatmapPage />} />
          <Route
            path="/events/:eventId/reservations/:reservationId"
            element={<ReservationPage />}
          />
          <Route path="/my-tickets" element={<MyTicketsPage />} />
          <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
          <Route path="/checkout/cancel" element={<CheckoutCancelPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
