import type { JSX } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { CheckoutCancelPage, CheckoutSuccessPage } from './routes/CheckoutResultPage.js';
import { EventPage } from './routes/EventPage.js';
import { EventsListPage } from './routes/EventsListPage.js';
import { MyTicketsPage } from './routes/MyTicketsPage.js';
import { ReservationPage } from './routes/ReservationPage.js';
import { SeatmapPage } from './routes/SeatmapPage.js';

/**
 * Root component (docs/plan.md "Domän och användarflöde"): välj
 * evenemang → väntrum → arenakarta → reservation → (inloggning +)
 * betalning, plus "mina biljetter" oberoende av flödet.
 */
export function App(): JSX.Element {
  return (
    <>
      <nav>
        <Link to="/">Evenemang</Link> | <Link to="/my-tickets">Mina biljetter</Link>
      </nav>
      <Routes>
        <Route path="/" element={<EventsListPage />} />
        <Route path="/events/:eventId" element={<EventPage />} />
        <Route path="/events/:eventId/seatmap" element={<SeatmapPage />} />
        <Route
          path="/events/:eventId/reservations/:reservationId"
          element={<ReservationPage />}
        />
        <Route path="/my-tickets" element={<MyTicketsPage />} />
        <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
        <Route path="/checkout/cancel" element={<CheckoutCancelPage />} />
      </Routes>
    </>
  );
}
