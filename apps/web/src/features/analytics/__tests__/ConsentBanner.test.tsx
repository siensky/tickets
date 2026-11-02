import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openConsentSettings } from '../../../lib/consent.js';
import { ConsentBanner } from '../ConsentBanner.js';

const { applyConsent } = vi.hoisted(() => ({ applyConsent: vi.fn() }));
vi.mock('../../../lib/analytics.js', () => ({ isAnalyticsConfigured: true, applyConsent }));

afterEach(() => {
  window.localStorage.clear();
  applyConsent.mockClear();
});

describe('ConsentBanner', () => {
  it('visas tills användaren valt, och godkännandet sparas och tillämpas', async () => {
    render(<ConsentBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Godkänn' }));

    expect(applyConsent).toHaveBeenCalledWith('granted');
    expect(window.localStorage.getItem('tikknet:analytics-consent')).toBe('granted');
    expect(screen.queryByRole('region', { name: 'Samtycke till statistik' })).toBeNull();
  });

  it('"Avvisa" sparar nekandet', async () => {
    render(<ConsentBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Avvisa' }));

    expect(applyConsent).toHaveBeenCalledWith('denied');
    expect(window.localStorage.getItem('tikknet:analytics-consent')).toBe('denied');
  });

  it('är dold efter ett val, men kan öppnas igen från Cookie-inställningar', async () => {
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    render(<ConsentBanner />);
    expect(screen.queryByRole('region', { name: 'Samtycke till statistik' })).toBeNull();

    openConsentSettings();
    expect(
      await screen.findByRole('region', { name: 'Samtycke till statistik' }),
    ).toBeInTheDocument();
  });
});
