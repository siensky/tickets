/**
 * Auth0-inloggning för scannern (docs/plan.md 7.8): vanlig Universal Login, ingen M2M. Anställda
 * har rollen `staff` med permissionen `scan:tickets`; audience är samma API som webbappen.
 */
import { Auth0Provider } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';

const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID;
const AUTH0_AUDIENCE = import.meta.env.VITE_AUTH0_AUDIENCE;

export const isAuth0Configured = AUTH0_DOMAIN !== undefined && AUTH0_CLIENT_ID !== undefined;

export function AppAuthProvider({ children }: { children: ReactNode }): JSX.Element {
  if (AUTH0_DOMAIN === undefined || AUTH0_CLIENT_ID === undefined) {
    return <>{children}</>;
  }
  return (
    <Auth0Provider
      domain={AUTH0_DOMAIN}
      clientId={AUTH0_CLIENT_ID}
      authorizationParams={{ redirect_uri: window.location.origin, audience: AUTH0_AUDIENCE }}
      // Personalen ska inte behöva logga in igen efter en omladdning mitt i en kö vid grinden.
      cacheLocation="localstorage"
    >
      {children}
    </Auth0Provider>
  );
}
