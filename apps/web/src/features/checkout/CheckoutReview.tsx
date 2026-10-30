/**
 * Granska och betala (docs/plan.md 7.11 F): biljetterna och summan kommer från SERVERNS
 * reservation, kunden från Auth0, och timern räknar mot serverns `expiresAt`. Betalningen
 * sker hos Stripe; webbappen ser aldrig kortuppgifter. Inga avgifter: backend har inga.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { Lock } from 'lucide-react';
import type { JSX } from 'react';
import { Alert } from '../../components/ui/Alert.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import type { ReservationView } from '../../lib/api-client.js';
import { formatPrice } from '../../lib/format.js';
import { useLogout } from '../../lib/use-logout.js';
import { ReservationTimer } from '../booking/ReservationTimer.js';
import { SelectedSeatList } from '../booking/SelectedSeatList.js';

function CustomerBlock(): JSX.Element {
  const { isAuthenticated, user } = useAuth0();
  const logout = useLogout();
  if (!isAuthenticated) {
    return <p className="text-muted">Du loggar in när du går vidare till betalning.</p>;
  }
  return (
    <div>
      <p className="font-medium">{user?.name ?? user?.email}</p>
      {user?.name === undefined || user.email === undefined ? null : (
        <p className="text-sm text-muted">{user.email}</p>
      )}
      <p className="mt-1 text-sm">
        Inte du?{' '}
        <button type="button" onClick={logout} className="link text-accent">
          Logga ut
        </button>
      </p>
    </div>
  );
}

function PaymentPanel({
  totalCents,
  ticketCount,
  payLabel,
  isPaying,
  errorMessage,
  onPay,
}: {
  totalCents: number;
  ticketCount: number;
  payLabel: string;
  isPaying: boolean;
  errorMessage: string | undefined;
  onPay: () => void;
}): JSX.Element {
  return (
    <aside className="flex flex-col gap-4 self-start rounded-box border border-base-300 bg-base-100 p-5 shadow-lg lg:sticky lg:top-24">
      <h2 className="text-lg">Att betala</h2>
      <div className="flex items-baseline justify-between">
        <span>
          Totalt
          <span className="block text-xs text-muted">
            {ticketCount} {ticketCount === 1 ? 'biljett' : 'biljetter'}
          </span>
        </span>
        <span className="text-2xl font-bold tabular-nums">{formatPrice(totalCents)}</span>
      </div>
      {errorMessage === undefined ? null : <Alert tone="error">{errorMessage}</Alert>}
      <Button size="lg" loading={isPaying} onClick={onPay}>
        {errorMessage === undefined ? payLabel : 'Försök igen'}
      </Button>
      <p className="flex items-start gap-2 text-sm text-muted">
        <Lock size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
        Betalningen sker hos Stripe. Vi ser aldrig dina kortuppgifter.
      </p>
    </aside>
  );
}

export function CheckoutReview({
  reservation,
  eventTitle,
  payLabel,
  isPaying,
  errorMessage,
  onPay,
}: {
  reservation: ReservationView;
  eventTitle: string;
  payLabel: string;
  isPaying: boolean;
  errorMessage: string | undefined;
  onPay: () => void;
}): JSX.Element {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-6">
        <ReservationTimer expiresAt={reservation.expiresAt} />
        <Card>
          <h2 className="text-lg">Dina biljetter</h2>
          <p className="mb-1 text-sm text-muted">{eventTitle}</p>
          <SelectedSeatList
            seats={reservation.seats.map((seat) => ({ ...seat, key: seat.seatId }))}
          />
        </Card>
        <Card>
          <h2 className="mb-2 text-lg">Kund</h2>
          <CustomerBlock />
        </Card>
      </div>
      <PaymentPanel
        totalCents={reservation.totalCents}
        ticketCount={reservation.seats.length}
        payLabel={payLabel}
        isPaying={isPaying}
        errorMessage={errorMessage}
        onPay={onPay}
      />
    </div>
  );
}
