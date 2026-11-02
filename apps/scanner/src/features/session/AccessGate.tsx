/**
 * Inloggning och behörighetskontroll (docs/plan.md 7.8): inloggning via Auth0, därefter krävs
 * permissionen `scan:tickets` i access-tokenet. Saknas den visas "Ditt konto har inte
 * scannerbehörighet" med utloggning. Barnen får en funktion som ger ett färskt access token.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { SCAN_PERMISSION } from '../../config.js';
import { isAuth0Configured } from '../../lib/auth-provider.js';
import { readPermissions } from '../../lib/permissions.js';
import { useAccessToken } from '../../lib/use-access-token.js';

type Access = 'checking' | 'allowed' | 'forbidden' | 'error';

function Message({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <img
        src="/brand/tikknet-logo.svg"
        alt="tikknet"
        width={109}
        height={28}
        className="h-7 w-auto self-start"
      />
      <h1>{title}</h1>
      {children}
    </main>
  );
}

function useScanAccess(): Access {
  const { isAuthenticated } = useAuth0();
  const getAccessToken = useAccessToken();
  const [access, setAccess] = useState<Access>('checking');
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    getAccessToken()
      .then((token) =>
        setAccess(readPermissions(token).includes(SCAN_PERMISSION) ? 'allowed' : 'forbidden'),
      )
      .catch(() => setAccess('error'));
  }, [isAuthenticated]);
  return access;
}

function LogoutButton(): JSX.Element {
  const { logout } = useAuth0();
  return (
    <button
      type="button"
      className="btn btn-outline btn-neutral min-h-11"
      onClick={() => void logout({ logoutParams: { returnTo: window.location.origin } })}
    >
      Logga ut
    </button>
  );
}

function LoginPrompt(): JSX.Element {
  const { loginWithRedirect } = useAuth0();
  return (
    <Message title="Logga in för att skanna biljetter">
      <button
        type="button"
        className="btn btn-primary min-h-12"
        onClick={() => void loginWithRedirect()}
      >
        Logga in
      </button>
    </Message>
  );
}

function AccessProblem({ access }: { access: 'forbidden' | 'error' }): JSX.Element {
  return access === 'forbidden' ? (
    <Message title="Ditt konto har inte scannerbehörighet">
      <p>Be en administratör ge ditt konto rollen staff.</p>
      <LogoutButton />
    </Message>
  ) : (
    <Message title="Kunde inte kontrollera behörigheten">
      <LogoutButton />
    </Message>
  );
}

export function AccessGate({
  children,
}: {
  children: (getAccessToken: () => Promise<string>, logoutButton: JSX.Element) => ReactNode;
}): JSX.Element {
  const { isAuthenticated, isLoading } = useAuth0();
  const getAccessToken = useAccessToken();
  const access = useScanAccess();

  if (!isAuth0Configured) {
    return <Message title="Inloggning är inte konfigurerad" />;
  }
  if (isLoading) {
    return (
      <Message title="Laddar…">
        <span className="loading loading-spinner loading-lg" aria-hidden="true" />
      </Message>
    );
  }
  if (!isAuthenticated) {
    return <LoginPrompt />;
  }
  if (access === 'forbidden' || access === 'error') {
    return <AccessProblem access={access} />;
  }
  if (access === 'checking') {
    return <Message title="Kontrollerar behörighet…" />;
  }
  return <>{children(getAccessToken, <LogoutButton />)}</>;
}
