import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelReservation } from '../../../lib/api-client.js';
import { renderWithProviders } from '../../../test/render.js';
import { BookingNav } from '../BookingNav.js';

vi.mock('../../../lib/api-client.js', () => ({ cancelReservation: vi.fn() }));

function renderNav(isPaying = false): void {
  renderWithProviders(
    <BookingNav eventId="e1" reservationId="r1" queueToken="tok" isPaying={isPaying} />,
    {
      route: '/events/e1/reservations/r1',
      path: '/events/:eventId/reservations/:reservationId',
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cancelReservation).mockResolvedValue(undefined);
});

describe('BookingNav', () => {
  it('"Tillbaka till stolsval" släpper stolarna och går till kartan', async () => {
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: /Tillbaka till stolsval/ }));
    expect(cancelReservation).toHaveBeenCalledWith('e1', 'r1', 'tok');
    await waitFor(() => expect(screen.getByText('annan sida')).toBeInTheDocument());
  });

  it('"Avbryt bokningen" släpper stolarna och går till eventet', async () => {
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Avbryt bokningen' }));
    expect(cancelReservation).toHaveBeenCalledWith('e1', 'r1', 'tok');
    await waitFor(() => expect(screen.getByText('annan sida')).toBeInTheDocument());
  });

  it('lämnar steget även om avbokningen misslyckas', async () => {
    vi.mocked(cancelReservation).mockRejectedValue(new Error('nätverk'));
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Avbryt bokningen' }));
    await waitFor(() => expect(screen.getByText('annan sida')).toBeInTheDocument());
  });

  it('låser knapparna medan betalningen startas', () => {
    renderNav(true);
    expect(screen.getByRole('button', { name: 'Avbryt bokningen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Tillbaka till stolsval/ })).toBeDisabled();
  });
});
