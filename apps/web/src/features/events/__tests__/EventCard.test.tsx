import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT } from '../../../test/api-fixtures.js';
import { renderWithProviders } from '../../../test/render.js';
import { EventCard } from '../EventCard.js';

const { useSeatsLeftFlag } = vi.hoisted(() => ({ useSeatsLeftFlag: vi.fn() }));
vi.mock('../use-seats-left-flag.js', () => ({ useSeatsLeftFlag }));

beforeEach(() => useSeatsLeftFlag.mockReset());

describe('EventCard "platser kvar"-badge (feature flag show_seats_left_badge)', () => {
  it('visas när flaggan är på och eventet går att boka', () => {
    useSeatsLeftFlag.mockReturnValue(true);
    renderWithProviders(<EventCard event={EVENT} />);
    expect(screen.getByText('100 platser kvar')).toBeInTheDocument();
  });

  it('visas inte när flaggan är av (default, eller utan samtycke)', () => {
    useSeatsLeftFlag.mockReturnValue(false);
    renderWithProviders(<EventCard event={EVENT} />);
    expect(screen.queryByText(/platser kvar/)).toBeNull();
  });

  it('visas inte för ett slutsålt event även med flaggan på', () => {
    useSeatsLeftFlag.mockReturnValue(true);
    renderWithProviders(
      <EventCard event={{ ...EVENT, availability: 'sold_out', availableSeats: 0 }} />,
    );
    expect(screen.queryByText(/platser kvar/)).toBeNull();
  });
});
