import { afterEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  set_config: vi.fn(),
  opt_in_capturing: vi.fn(),
  reloadFeatureFlags: vi.fn(),
  clear_opt_in_out_capturing: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: posthog }));

describe('analytics utan VITE_POSTHOG_KEY', () => {
  it('gör ingenting: ingen init, ingen capture, ingen identify', async () => {
    const analytics = await import('../analytics.js');

    analytics.initAnalytics();
    analytics.track('queue_joined', { event_id: 'e1', category: 'music' });
    analytics.identifyUser('auth0|abc');
    analytics.resetAnalytics();

    expect(analytics.isAnalyticsConfigured).toBe(false);
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
  });
});

describe('analytics med VITE_POSTHOG_KEY', () => {
  async function loadConfigured(): Promise<typeof import('../analytics.js')> {
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
    return import('../analytics.js');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
    Object.values(posthog).forEach((fn) => fn.mockClear());
  });

  it('startar cookielöst och utan feature flags innan samtycke', async () => {
    const analytics = await loadConfigured();
    analytics.initAnalytics();

    expect(posthog.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: '/ingest',
        persistence: 'memory',
        capture_pageview: 'history_change',
        advanced_disable_feature_flags_on_first_load: true,
      }),
    );
  });

  it('startar med cookie och flaggor när samtycke redan givits', async () => {
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    const analytics = await loadConfigured();
    analytics.initAnalytics();

    expect(posthog.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        persistence: 'localStorage+cookie',
        advanced_disable_feature_flags_on_first_load: false,
      }),
    );
  });

  it('identifierar bara efter samtycke', async () => {
    const analytics = await loadConfigured();
    analytics.identifyUser('auth0|abc');
    expect(posthog.identify).not.toHaveBeenCalled();

    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    analytics.identifyUser('auth0|abc');
    expect(posthog.identify).toHaveBeenCalledWith('auth0|abc');
  });
});
