/**
 * `/checkout/success` + `/checkout/cancel` — where Stripe Checkout
 * redirects the browser back to (docs/plan.md "Domän och
 * användarflöde": "betalning → bekräftelse"). Stripe's `success_url`
 * carries no session id (services/booking-api/src/services/
 * checkout-service.ts), so this page can't verify anything itself —
 * the real confirmation (order status, minted tickets) comes from the
 * webhook-driven flow and shows up under "Mina biljetter".
 */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';

export function CheckoutSuccessPage(): JSX.Element {
  return (
    <section>
      <h1>Tack för ditt köp!</h1>
      <p>
        Betalningen behandlas. Dina biljetter dyker upp under{' '}
        <Link to="/my-tickets">Mina biljetter</Link> så snart den är klar.
      </p>
    </section>
  );
}

export function CheckoutCancelPage(): JSX.Element {
  return (
    <section>
      <h1>Betalningen avbröts</h1>
      <p>
        Ingen betalning har gjorts. Din reservation gäller fortfarande om tiden inte gått ut.
      </p>
      <Link to="/">Till evenemang</Link>
    </section>
  );
}
