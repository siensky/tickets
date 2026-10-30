/**
 * Inloggning och användarmeny. Utloggad: "Logga in". Inloggad: "Mina biljetter" och en
 * avatar-meny med namn och "Logga ut". Renderar ingenting om Auth0 inte är konfigurerat
 * (lokal utveckling), eftersom `useAuth0()` utan provider aldrig slutar ladda.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { Ticket } from 'lucide-react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { isAuth0Configured } from '../../lib/auth-provider.js';
import { useLogout } from '../../lib/use-logout.js';
import { Button, buttonClass } from '../ui/Button.js';

function initialsOf(name: string | undefined): string {
  const letters = (name ?? '?')
    .split(/[\s@.]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase());
  return letters.join('') || '?';
}

function AvatarMenu(): JSX.Element {
  const { user } = useAuth0();
  const logout = useLogout();
  const label = user?.name ?? user?.email ?? 'Konto';
  return (
    <details className="dropdown dropdown-end">
      <summary
        className="btn btn-circle btn-neutral min-h-11 min-w-11"
        aria-label={`Kontomeny för ${label}`}
      >
        {initialsOf(label)}
      </summary>
      <ul className="menu dropdown-content z-50 mt-2 w-64 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
        <li className="menu-title truncate">{label}</li>
        <li>
          <Link to="/my-tickets">Mina biljetter</Link>
        </li>
        <li>
          <button type="button" onClick={logout}>
            Logga ut
          </button>
        </li>
      </ul>
    </details>
  );
}

export function UserMenu({ variant }: { variant: 'bar' | 'drawer' }): JSX.Element | null {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  if (!isAuth0Configured || isLoading) {
    return null;
  }
  const isDrawer = variant === 'drawer';
  const ticketsLink = (
    <Link
      to="/my-tickets"
      className={buttonClass('ghost', 'md', isDrawer ? 'justify-start' : '')}
    >
      <Ticket size={16} strokeWidth={1.75} aria-hidden="true" />
      Mina biljetter
    </Link>
  );
  if (isAuthenticated) {
    return isDrawer ? (
      <DrawerAccount>{ticketsLink}</DrawerAccount>
    ) : (
      <div className="flex items-center gap-2">
        {ticketsLink}
        <AvatarMenu />
      </div>
    );
  }
  return (
    <div className={isDrawer ? 'flex flex-col gap-2' : 'flex items-center gap-2'}>
      {ticketsLink}
      <Button
        variant="primary"
        onClick={() =>
          void loginWithRedirect({ appState: { returnTo: window.location.pathname } })
        }
      >
        Logga in
      </Button>
    </div>
  );
}

function DrawerAccount({ children }: { children: JSX.Element }): JSX.Element {
  const logout = useLogout();
  return (
    <div className="flex flex-col gap-2">
      {children}
      <Button variant="secondary" onClick={logout}>
        Logga ut
      </Button>
    </div>
  );
}
