/**
 * Auth0 login (docs/plan.md "Auth": "Inloggning krävs först vid
 * betalning, efter reservation"). Wraps the app so `useAuth0()` is
 * available everywhere, but only checkout and "mina biljetter"
 * actually call it — the queue/seatmap/reservation flow stays fully
 * anonymous, authenticated only by its queue token.
 */
import { Auth0Provider, type AppState } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID;
const AUTH0_AUDIENCE = import.meta.env.VITE_AUTH0_AUDIENCE;

/**
 * Login-gated pages must check this instead of relying on `useAuth0()`
 * outside a provider to "fail loudly": the SDK's own stub context
 * (used when there's no `Auth0Provider` above it) reports
 * `isLoading: true` forever, which just looks like an infinite spinner
 * rather than a clear configuration error.
 */
export const isAuth0Configured = AUTH0_DOMAIN !== undefined && AUTH0_CLIENT_ID !== undefined;

export function AppAuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate();

  if (AUTH0_DOMAIN === undefined || AUTH0_CLIENT_ID === undefined) {
    // Lets the anonymous queue/seatmap/reservation flow run without
    // Auth0 configured (local dev, e2e) — login-gated pages check
    // `isAuth0Configured` themselves instead of trusting `useAuth0()`.
    // (Checked directly, not via `isAuth0Configured`, so TypeScript can
    // narrow AUTH0_DOMAIN/AUTH0_CLIENT_ID to `string` below.)
    return <>{children}</>;
  }

  // Without this, the SDK's default redirect handler sends the user
  // back to "/" after login — losing which reservation they were
  // paying for (docs/plan.md "Inloggning krävs först vid betalning,
  // efter reservation": login must hand the user BACK to checkout,
  // not drop them on the events list).
  function handleRedirectCallback(appState: AppState | undefined): void {
    void navigate(appState?.returnTo ?? '/');
  }

  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: AUTH0_AUDIENCE,
      }}
      onRedirectCallback={handleRedirectCallback}
      // docs/plan.md "Offline": "mina biljetter" must still work after
      // a reload with no network. The SDK's default in-memory cache is
      // wiped on every reload and falls back to a network-dependent
      // silent check, which fails offline — localStorage survives the
      // reload without needing a network round trip.
      cacheLocation="localstorage"
    >
      {children}
    </Auth0Provider>
  );
}
