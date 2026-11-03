import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeatStatusEntry } from '../../../lib/api-client.js';
import { HeldSeatNotice } from '../HeldSeatNotice.js';

const SEAT = { id: 'vs1', row: 'C', number: 12, x: 1, y: 2 };
const NOW = new Date('2030-01-01T12:00:00.000Z');

function entry(overrides: Partial<SeatStatusEntry>): SeatStatusEntry {
  return {
    seatId: 's1',
    venueSeatId: 'vs1',
    status: 'held',
    priceCents: 1000,
    heldUntil: '2030-01-01T12:04:30.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('HeldSeatNotice', () => {
  it('räknar ner live till när reservationen går ut', () => {
    render(<HeldSeatNotice seat={SEAT} entry={entry({})} />);
    expect(screen.getByText(/Rad C, plats 12/)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('4:30');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent('4:25');
  });

  it('säger att stolen släpps strax när tiden gått ut', () => {
    render(
      <HeldSeatNotice seat={SEAT} entry={entry({ heldUntil: '2030-01-01T11:59:00.000Z' })} />,
    );
    expect(screen.getByText(/släpps strax/)).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('visar betalning pågår utan nedräkning när stolen är i betalning', () => {
    render(<HeldSeatNotice seat={SEAT} entry={entry({ heldUntil: null })} />);
    expect(screen.getByText(/betalning pågår/)).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('byter text när stolen blivit ledig eller såld', () => {
    const { rerender } = render(
      <HeldSeatNotice seat={SEAT} entry={entry({ status: 'available', heldUntil: null })} />,
    );
    expect(screen.getByText(/ledig igen/)).toBeInTheDocument();
    rerender(
      <HeldSeatNotice seat={SEAT} entry={entry({ status: 'sold', heldUntil: null })} />,
    );
    expect(screen.getByText(/har sålts/)).toBeInTheDocument();
  });

  it('visar inte "NaN" när ett äldre svar saknar heldUntil helt', () => {
    const old = { seatId: 's1', venueSeatId: 'vs1', status: 'held', priceCents: 1000 };
    render(<HeldSeatNotice seat={SEAT} entry={old as unknown as SeatStatusEntry} />);
    expect(screen.getByText(/betalning pågår/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('NaN');
  });
});
