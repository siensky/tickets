/**
 * Ett kort per order (docs/plan.md 7.11 "Mina biljetter"): eventet, datum, arena och varje
 * biljett med sektion, rad och plats. QR-koden öppnas i en modal. Fungerar offline mot
 * service workerns cachade lista; sidan visar då en "Offline"-badge.
 */
import { QrCode } from 'lucide-react';
import { useState, type JSX } from 'react';
import { Badge } from '../../components/ui/Badge.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import type { MyTicket, MyTicketOrder } from '../../lib/api-client.js';
import { formatEventDate, formatPrice } from '../../lib/format.js';
import { QrModal } from './QrModal.js';

const TICKET_STATUS_LABEL: Record<string, string> = {
  valid: 'Giltig',
  refunded: 'Återbetald',
  void: 'Ogiltig',
};
const ORDER_STATUS_LABEL: Record<string, string> = {
  paid: 'Betald',
  pending: 'Väntar på betalning',
  refunded: 'Återbetald',
  cancelled: 'Avbruten',
};

function TicketRow({
  ticket,
  eventTitle,
}: {
  ticket: MyTicket;
  eventTitle: string;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const caption = `${ticket.sectionName}, rad ${ticket.row}, plats ${ticket.number}`;
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div>
        <p className="font-medium">{caption}</p>
        <p className="text-sm text-muted">
          {TICKET_STATUS_LABEL[ticket.status] ?? ticket.status}
        </p>
      </div>
      {ticket.status === 'valid' ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => setIsOpen(true)}>
            <QrCode size={16} strokeWidth={1.75} aria-hidden="true" />
            Visa QR-kod
            <span className="sr-only"> för {caption}</span>
          </Button>
          <QrModal
            open={isOpen}
            onClose={() => setIsOpen(false)}
            title={eventTitle}
            caption={caption}
            qrToken={ticket.qrToken}
          />
        </>
      ) : null}
    </li>
  );
}

export function TicketCard({ order }: { order: MyTicketOrder }): JSX.Element {
  return (
    <Card>
      <article aria-labelledby={`order-${order.orderId}`}>
        <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id={`order-${order.orderId}`} className="text-lg">
              {order.eventTitle}
            </h2>
            <p className="text-sm text-muted">
              {order.eventStartsAt === null
                ? ''
                : `${formatEventDate(order.eventStartsAt)} · `}
              {order.venueName}, {order.venueCity}
            </p>
          </div>
          <Badge tone={order.status === 'paid' ? 'success' : 'neutral'}>
            {ORDER_STATUS_LABEL[order.status] ?? order.status}
          </Badge>
        </header>
        <ul className="divide-y divide-base-300">
          {order.tickets.map((ticket) => (
            <TicketRow key={ticket.ticketId} ticket={ticket} eventTitle={order.eventTitle} />
          ))}
        </ul>
        <p className="mt-2 text-right text-sm text-muted tabular-nums">
          Totalt {formatPrice(order.totalCents)}
        </p>
      </article>
    </Card>
  );
}
