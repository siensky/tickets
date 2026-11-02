/** Enhetstest för Auth0-leverantören i scannern: refresh tokens och svenskt inloggningsspråk (docs/plan.md 8.2). */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const providerProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));
vi.mock('@auth0/auth0-react', () => ({
  Auth0Provider: (props: Record<string, unknown>) => {
    providerProps.current = props;
    return null;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('AppAuthProvider (scanner)', () => {
  it('slår på refresh tokens med iframe-fallback och ber om svenska', async () => {
    vi.stubEnv('VITE_AUTH0_DOMAIN', 'tenant.example.auth0.com');
    vi.stubEnv('VITE_AUTH0_CLIENT_ID', 'client');
    vi.stubEnv('VITE_AUTH0_AUDIENCE', 'https://api.example');
    const { AppAuthProvider } = await import('../auth-provider.js');

    render(<AppAuthProvider>barn</AppAuthProvider>);

    expect(providerProps.current).toMatchObject({
      useRefreshTokens: true,
      useRefreshTokensFallback: true,
      cacheLocation: 'localstorage',
      authorizationParams: {
        ui_locales: 'sv',
        audience: 'https://api.example',
        redirect_uri: window.location.origin,
      },
    });
  });
});
