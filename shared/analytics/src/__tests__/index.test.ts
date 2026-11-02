import { describe, expect, it, vi } from 'vitest';
import { createTracker, type ClientEvents } from '../index.js';
import { createServerAnalytics, createServerAnalyticsFromEnv } from '../server.js';

describe('createTracker', () => {
  it('gör ingenting utan sink', () => {
    const tracker = createTracker<ClientEvents>(null);
    expect(() =>
      tracker.track('event_viewed', { event_id: 'e1', category: 'music' }),
    ).not.toThrow();
  });

  it('skickar händelsenamn och props till sinken', () => {
    const capture = vi.fn();
    const tracker = createTracker<ClientEvents>({ capture });
    tracker.track('queue_joined', { event_id: 'e1', category: 'music' });
    expect(capture).toHaveBeenCalledWith('queue_joined', {
      event_id: 'e1',
      category: 'music',
    });
  });
});

describe('createServerAnalytics', () => {
  it('är no-op utan nyckel', async () => {
    const analytics = createServerAnalytics({ apiKey: undefined, enabled: true });
    expect(() =>
      analytics.track('s', 'reservation_expired', { event_id: 'e1' }, { personless: true }),
    ).not.toThrow();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
  });

  it('är no-op när POSTHOG_ENABLED=false trots nyckel', () => {
    const analytics = createServerAnalyticsFromEnv({
      POSTHOG_KEY: 'phc_test',
      POSTHOG_ENABLED: 'false',
    });
    // Ingen PostHog-klient skapas, så shutdown har inget att vänta på.
    return expect(analytics.shutdown()).resolves.toBeUndefined();
  });
});
