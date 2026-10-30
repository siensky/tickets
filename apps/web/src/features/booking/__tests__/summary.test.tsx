import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReservationView } from '../../../lib/api-client.js';
import { CheckoutReview } from '../../checkout/CheckoutReview.js';
import { BookingSummaryPanel } from '../BookingSummaryPanel.js';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    user: { name: 'Sara Test', email: 'sara@example.com' },
    logout: vi.fn(),
  }),
}));

const seats = [
  { key: 'a', row: 'C', number: 12, sectionName: 'Golv', priceCents: 45_000 },
  { key: 'b', row: 'C', number: 13, sectionName: 'Golv', priceCents: 45_000 },
];

function renderPanel(
  props: Partial<ComponentProps<typeof BookingSummaryPanel>> = {},
): ReturnType<typeof render> {
  return render(
    <BookingSummaryPanel
      eventTitle="Neon Rivers"
      seats={seats}
      isReserving={false}
      errorMessage={undefined}
      onReserve={vi.fn()}
      {...props}
    />,
  );
}

describe('BookingSummaryPanel', () => {
  it('visar valda stolar och en preliminär summa', () => {
    renderPanel();
    expect(screen.getByText('2/5 valda')).toBeInTheDocument();
    expect(screen.getByText('Preliminär summa')).toBeInTheDocument();
    expect(screen.getByText(/900\skr/)).toBeInTheDocument();
  });

  it('stänger av knappen utan val', () => {
    renderPanel({ seats: [] });
    expect(screen.getByRole('button', { name: 'Reservera och gå vidare' })).toBeDisabled();
  });

  it('reserverar vid klick', async () => {
    const onReserve = vi.fn();
    renderPanel({ onReserve });
    await userEvent.click(screen.getByRole('button', { name: 'Reservera och gå vidare' }));
    expect(onReserve).toHaveBeenCalledOnce();
  });

  it('visar felet från servern', () => {
    renderPanel({ errorMessage: 'Platserna är tagna' });
    expect(screen.getByRole('alert')).toHaveTextContent('Platserna är tagna');
  });
});

describe('CheckoutReview', () => {
  it('visar serverns totalsumma, inte en summa räknad i klienten', () => {
    const reservation: ReservationView = {
      reservationId: 'r1',
      eventId: 'e1',
      queueTokenId: 'q1',
      status: 'active',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      seatIds: ['s1'],
      seats: [
        {
          seatId: 's1',
          sectionId: 'sec',
          sectionName: 'Golv',
          row: 'A',
          number: 1,
          priceCents: 10_000,
        },
      ],
      totalCents: 12_345,
      currency: 'SEK',
    };
    render(
      <MemoryRouter>
        <CheckoutReview
          reservation={reservation}
          eventTitle="Neon Rivers"
          payLabel="Betala med Stripe"
          isPaying={false}
          errorMessage={undefined}
          onPay={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/123\s?kr|123,45/)).toBeInTheDocument();
    expect(screen.getByText('Sara Test')).toBeInTheDocument();
    expect(screen.getByText(/Vi ser aldrig dina kortuppgifter/)).toBeInTheDocument();
  });
});
