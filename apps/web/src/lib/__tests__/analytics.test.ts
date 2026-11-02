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
  startSessionRecording: vi.fn(),
  sessionRecordingStarted: vi.fn().mockReturnValue(false),
  stopSessionRecording: vi.fn(),
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

  it('startar inte session replay utan samtycke, och maskerar allt när den startar', async () => {
    const analytics = await loadConfigured();
    analytics.initAnalytics();

    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    const config = posthog.init.mock.calls[0]?.[1] as {
      disable_session_recording: boolean;
      enable_recording_console_log: boolean;
      capture_performance: Record<string, unknown>;
      session_recording: Record<string, unknown> & {
        maskAttributeFn: (name: string, value: string) => string;
      };
    };
    expect(config.disable_session_recording).toBe(true);
    expect(config.enable_recording_console_log).toBe(false);
    expect(config.capture_performance).toEqual({ network_timing: false, web_vitals: false });
    // Namn och e-post i t.ex. kontomenyns aria-label får inte hamna i inspelningen.
    expect(config.session_recording.maskAttributeFn('aria-label', 'Sara Test')).toBe(
      '*********',
    );
    expect(config.session_recording.maskAttributeFn('class', 'btn')).toBe('btn');
    expect(config.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
      recordHeaders: false,
      recordBody: false,
    });
  });

  it('startar replay när samtycke redan givits och stoppar den när samtycket återkallas', async () => {
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    const analytics = await loadConfigured();
    analytics.initAnalytics();
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);

    analytics.applyConsent('denied');
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('startar replay först när användaren godkänner', async () => {
    const analytics = await loadConfigured();
    analytics.initAnalytics();
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');

    analytics.applyConsent('granted');

    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('laddar om sidan när en pågående inspelning avbryts av återkallat samtycke', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    posthog.sessionRecordingStarted.mockReturnValueOnce(true);
    const analytics = await loadConfigured();

    analytics.applyConsent('denied');

    expect(posthog.stopSessionRecording).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('laddar inte om sidan när ingen inspelning pågick', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const analytics = await loadConfigured();

    analytics.applyConsent('denied');

    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('stoppar replay när samtycket återkallas i en annan flik (storage-event)', async () => {
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    const analytics = await loadConfigured();
    analytics.initAnalytics();

    window.localStorage.setItem('tikknet:analytics-consent', 'denied');
    window.dispatchEvent(new StorageEvent('storage', { key: 'tikknet:analytics-consent' }));

    // (toHaveBeenCalled: lyssnare från tidigare testers modulinstanser ligger kvar på window.)
    expect(posthog.stopSessionRecording).toHaveBeenCalled();
  });

  it('startar inte replay om Auth0:s återkomst ligger kvar när väntan är slut', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    window.history.replaceState({}, '', '/?error=access_denied&state=xyz');
    const analytics = await loadConfigured();
    analytics.initAnalytics();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    window.history.replaceState({}, '', '/');
    vi.useRealTimers();
  });

  it('väntar med replay så länge Auth0:s återkomst (code/state) ligger i adressfältet', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('tikknet:analytics-consent', 'granted');
    window.history.replaceState({}, '', '/?code=abc&state=xyz');
    const analytics = await loadConfigured();
    analytics.initAnalytics();
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();

    window.history.replaceState({}, '', '/');
    await vi.advanceTimersByTimeAsync(600);

    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
