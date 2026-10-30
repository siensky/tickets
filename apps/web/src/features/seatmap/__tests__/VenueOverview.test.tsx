import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SectionSummary, SectionSummaryEntry } from '../../../lib/api-client.js';
import { expectNoA11yViolations } from '../../../test/axe.js';
import { VenueOverview } from '../VenueOverview.js';

function section(overrides: Partial<SectionSummaryEntry>): SectionSummaryEntry {
  return {
    id: 's1',
    name: 'Golv',
    displayOrder: 1,
    layout: { x: 100, y: 200, width: 300, height: 150, rotation: 0 },
    availableCount: 80,
    totalCount: 200,
    minPriceCents: 39_500,
    maxPriceCents: 59_500,
    availability: 'on_sale',
    ...overrides,
  };
}

const STAGE = { x: 300, y: 40, width: 400, height: 80 };

describe('VenueOverview med layout', () => {
  it('öppnar en sektion via klick och via tangentbord', async () => {
    const onSelect = vi.fn();
    const summary: SectionSummary = { stage: STAGE, sections: [section({})] };
    render(<VenueOverview summary={summary} onSelect={onSelect} />);
    const button = screen.getByRole('button', { name: /^Golv, 80 kvar, 395 kr – 595 kr/ });
    await userEvent.click(button);
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('öppnar inte en slutsåld sektion', async () => {
    const onSelect = vi.fn();
    const summary: SectionSummary = {
      stage: STAGE,
      sections: [section({ availability: 'sold_out', availableCount: 0 })],
    };
    render(<VenueOverview summary={summary} onSelect={onSelect} />);
    const button = screen.getByRole('button', { name: 'Golv, slutsåld' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('VenueOverview utan layout', () => {
  const summary: SectionSummary = {
    stage: null,
    sections: [
      section({ layout: null }),
      section({ id: 's2', name: 'Läktare', layout: null, availability: 'sold_out' }),
    ],
  };

  it('visar sektionerna som kort och stänger av slutsålda', () => {
    render(<VenueOverview summary={summary} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Golv/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Läktare/ })).toBeDisabled();
    expect(screen.getByText('Slutsåld')).toBeInTheDocument();
  });

  it('saknar tillgänglighetsfel', async () => {
    const { container } = render(<VenueOverview summary={summary} onSelect={vi.fn()} />);
    await expectNoA11yViolations(container);
  });
});
