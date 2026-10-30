import { screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrder, type OrderView } from '../../../lib/api-client.js';
import { renderWithProviders } from '../../../test/render.js';
import {
  ORDER_POLL_MS,
  ORDER_POLL_TIMEOUT_MS,
  PaymentStatusPoller,
} from '../PaymentStatusPoller.js';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: () => Promise.resolve('access-token') }),
}));
vi.mock('../../../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api-client.js')>()),
  getOrder: vi.fn(),
}));

function order(status: OrderView['status']): OrderView {
  return { orderId: 'o1', eventId: 'e1', status, totalCents: 90_000, ticketCount: 2 };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPoller(): void {
  renderWithProviders(<PaymentStatusPoller eventId="e1" orderId="o1" />);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PaymentStatusPoller', () => {
  it('visar "Bekräftar betalningen…" och sedan bekräftelsen först när backend säger paid', async () => {
    vi.mocked(getOrder)
      .mockResolvedValueOnce(order('pending'))
      .mockResolvedValue(order('paid'));
    renderPoller();
    await advance(10);
    expect(screen.getByText('Bekräftar betalningen…')).toBeInTheDocument();
    expect(screen.queryByText('Tack för ditt köp!')).not.toBeInTheDocument();

    await advance(ORDER_POLL_MS + 10);
    expect(screen.getByText('Tack för ditt köp!')).toBeInTheDocument();
    expect(getOrder).toHaveBeenCalledWith('e1', 'o1', 'access-token');
  });

  it('visar aldrig "klart" när ordern fortfarande är pending, och ger upp efter 60 s', async () => {
    vi.mocked(getOrder).mockResolvedValue(order('pending'));
    renderPoller();
    await advance(ORDER_POLL_TIMEOUT_MS - 1_000);
    expect(screen.queryByText('Tack för ditt köp!')).not.toBeInTheDocument();
    expect(screen.queryByText(/Vi har inte fått bekräftelsen än/)).not.toBeInTheDocument();

    await advance(2_000);
    expect(screen.getByText(/Vi har inte fått bekräftelsen än/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gå till Mina biljetter' })).toBeInTheDocument();

    const callsAtTimeout = vi.mocked(getOrder).mock.calls.length;
    await advance(10_000);
    expect(vi.mocked(getOrder).mock.calls.length).toBe(callsAtTimeout);
  });

  it('förklarar en återbetalning', async () => {
    vi.mocked(getOrder).mockResolvedValue(order('refunded'));
    renderPoller();
    await advance(10);
    expect(screen.getByText(/har återbetalats/)).toBeInTheDocument();
  });

  it('förklarar en avbruten order', async () => {
    vi.mocked(getOrder).mockResolvedValue(order('cancelled'));
    renderPoller();
    await advance(10);
    expect(screen.getByText('Ordern avbröts.')).toBeInTheDocument();
  });

  it('visar ett fel med "Försök igen" när ordern inte kan hämtas', async () => {
    vi.mocked(getOrder).mockRejectedValue(new Error('404'));
    renderPoller();
    await advance(10);
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeInTheDocument();
  });
});
