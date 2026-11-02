/** Enhetstest för ScanResultOverlay (scannern, docs/plan.md 7.8). */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test/axe.js';
import { ScanResultOverlay, type ScanDisplay } from '../ScanResultOverlay.js';

function renderOverlay(display: ScanDisplay): HTMLElement {
  const { container } = render(
    <ScanResultOverlay display={display} eventTitle="Neon Rivers" />,
  );
  return container;
}

describe('ScanResultOverlay', () => {
  it('visar eventnamn och sektion/rad/stol för en giltig biljett', async () => {
    const container = renderOverlay({
      result: 'ok',
      sectionName: 'Parkett',
      row: 'C',
      number: 12,
    });
    expect(screen.getByRole('heading', { name: 'Giltig biljett' })).toBeInTheDocument();
    expect(screen.getByText(/Neon Rivers/)).toBeInTheDocument();
    expect(screen.getByText(/Parkett, rad C, plats 12/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('visar när och var en biljett redan skannades', async () => {
    const container = renderOverlay({
      result: 'already_scanned',
      scannedAt: '2026-11-27T18:42:00Z',
      gate: 'Grind B',
    });
    expect(screen.getByText('Redan skannad 19:42 vid Grind B')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it.each([
    [{ result: 'not_found' } as const, 'Biljetten gäller inte detta event eller är ogiltig'],
    [{ result: 'refunded' } as const, 'Biljetten är återbetald och gäller inte'],
    [{ result: 'void' } as const, 'Biljetten har spärrats'],
    [{ result: 'error' } as const, 'Något gick fel. Skanna biljetten igen.'],
  ])('förklarar %j i text', (display, text) => {
    renderOverlay(display);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
