/** Bekräftelsen som visas först när backend säger `paid`. */
import { CheckCircle2 } from 'lucide-react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass } from '../../components/ui/Button.js';
import type { OrderView } from '../../lib/api-client.js';
import { formatPrice } from '../../lib/format.js';

export function OrderConfirmation({ order }: { order: OrderView }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <CheckCircle2 size={48} strokeWidth={1.75} className="text-success" aria-hidden="true" />
      <h2 className="text-2xl">Tack för ditt köp!</h2>
      <p>
        Betalningen är bekräftad. {order.ticketCount}{' '}
        {order.ticketCount === 1 ? 'biljett' : 'biljetter'} · {formatPrice(order.totalCents)}
      </p>
      <p className="max-w-md text-muted">
        Dina biljetter med QR-kod finns under Mina biljetter och fungerar även utan internet.
      </p>
      <Link to="/my-tickets" className={buttonClass('primary', 'lg')}>
        Visa mina biljetter
      </Link>
    </div>
  );
}
