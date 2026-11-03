/**
 * Tillbaka från Stripe utan att betala: sidan avbryter bokningen direkt (stolarna släpps), och visar
 * "Välj platser igen". Säger servern att betalningen redan pågår hänvisas kunden till Mina biljetter.
 */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api-client.js';
import { renderWithProviders } from '../../test/render.js';
import { CheckoutCancelPage } from '../CheckoutResultPage.js';

const storedToken = vi.hoisted((): { value: string | undefined } => ({
  value: 'queue-token',
}));
vi.mock('../../lib/queue-token-storage.js', () => ({
  getStoredQueueToken: () => storedToken.value,
}));
vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api-client.js')>();
  return { ...original, cancelReservation: vi.fn(), getEvent: vi.fn() };
});

const ROUTE = {
  route: '/checkout/cancel?event_id=e1&reservation_id=r1',
  path: '/checkout/cancel',
};

beforeEach(() => {
  storedToken.value = 'queue-token';
  vi.mocked(api.cancelReservation).mockReset();
  vi.mocked(api.getEvent).mockReturnValue(new Promise(() => undefined));
});

describe('CheckoutCancelPage', () => {
  it('avbryter bokningen och erbjuder att välja platser igen', async () => {
    vi.mocked(api.cancelReservation).mockResolvedValue(undefined);
    renderWithProviders(<CheckoutCancelPage />, ROUTE);

    expect(await screen.findByText(/Platserna är släppta/)).toBeInTheDocument();
    expect(api.cancelReservation).toHaveBeenCalledWith('e1', 'r1', 'queue-token');
    expect(screen.getByRole('link', { name: 'Välj platser igen' })).toHaveAttribute(
      'href',
      '/events/e1/queue',
    );
  });

  it('hänvisar till Mina biljetter när betalningen redan pågår', async () => {
    vi.mocked(api.cancelReservation).mockRejectedValue(
      new api.ApiError('busy', 409, 'ACTIVE_RESERVATION_EXISTS'),
    );
    renderWithProviders(<CheckoutCancelPage />, ROUTE);

    expect(
      await screen.findByText(/Betalningen verkar redan ha gått igenom/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gå till Mina biljetter' })).toBeInTheDocument();
  });

  it('säger ärligt att avbokningen inte gick när Stripe inte svarar, och kan försöka igen', async () => {
    vi.mocked(api.cancelReservation)
      .mockRejectedValueOnce(new api.ApiError('down', 503, 'PAYMENT_PROVIDER_UNAVAILABLE'))
      .mockResolvedValueOnce(undefined);
    renderWithProviders(<CheckoutCancelPage />, ROUTE);

    expect(
      await screen.findByText(/Vi kunde inte avbryta bokningen just nu/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Betalningen verkar redan/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Försök igen' }));
    expect(await screen.findByText(/Platserna är släppta/)).toBeInTheDocument();
  });

  it('anropar inget utan sparad kötoken', async () => {
    storedToken.value = undefined;
    renderWithProviders(<CheckoutCancelPage />, ROUTE);

    expect(await screen.findByText('Ingen betalning har gjorts.')).toBeInTheDocument();
    expect(api.cancelReservation).not.toHaveBeenCalled();
  });
});
