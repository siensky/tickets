/**
 * Bakåt och avbryt överst i checkout: "Tillbaka till stolsval" och "Avbryt bokningen" släpper båda
 * reservationens stolar direkt (annars står de som upptagna för användaren själv tills tiden gått ut).
 * Navigeringen väntar inte på svaret: misslyckas avbokningen släpps stolarna ändå när kartan öppnas
 * eller tiden går ut.
 */
import { ArrowLeft } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button.js';
import { cancelReservation } from '../../lib/api-client.js';
import { clearLastReservationId } from '../../lib/reservation-storage.js';

export function BookingNav({
  eventId,
  reservationId,
  queueToken,
  isPaying,
}: {
  eventId: string;
  reservationId: string;
  queueToken: string;
  /** Betalningen startas just nu: knapparna låses så att användaren inte lämnar mitt i övergången till Stripe. */
  isPaying: boolean;
}): JSX.Element {
  const navigate = useNavigate();
  const [isLeaving, setIsLeaving] = useState(false);

  function leaveTo(path: string): void {
    setIsLeaving(true);
    clearLastReservationId(eventId);
    cancelReservation(eventId, reservationId, queueToken)
      .catch(() => undefined)
      .finally(() => void navigate(path));
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3"
        disabled={isLeaving || isPaying}
        onClick={() => leaveTo(`/events/${eventId}/seatmap`)}
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Tillbaka till stolsval
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={isLeaving || isPaying}
        onClick={() => leaveTo(`/events/${eventId}`)}
      >
        Avbryt bokningen
      </Button>
    </div>
  );
}
