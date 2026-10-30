import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Seat, seatAriaLabel, type SeatVisualState } from '../Seat.js';

const SEAT = { id: 'venue-seat-1', row: 'C', number: 12, x: 1, y: 2 };

function renderSeat(state: SeatVisualState, onToggle = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <svg>
      <Seat seat={SEAT} state={state} priceCents={45_000} tabIndex={0} onToggle={onToggle} />
    </svg>,
  );
  return onToggle;
}

describe('Seat', () => {
  it.each<[SeatVisualState, string]>([
    ['available', 'ledig'],
    ['held', 'upptagen'],
    ['sold', 'såld'],
    ['selected', 'vald av dig'],
  ])('beskriver status %s i aria-label', (state, word) => {
    renderSeat(state);
    expect(
      screen.getByRole('button', { name: new RegExp(`Rad C, plats 12, 450\\skr, ${word}`) }),
    ).toBeInTheDocument();
  });

  it('markerar vald stol med aria-pressed och ej valbara stolar med aria-disabled', () => {
    renderSeat('selected');
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('avstår från aria-pressed och sätter aria-disabled på såld stol', () => {
    renderSeat('sold');
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('anropar onToggle med stolens id vid klick', async () => {
    const onToggle = renderSeat('available');
    await userEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledWith('venue-seat-1');
  });

  it('bygger etiketten utan pris när priset saknas', () => {
    expect(seatAriaLabel(SEAT, undefined, 'available')).toBe('Rad C, plats 12, ledig');
  });
});
