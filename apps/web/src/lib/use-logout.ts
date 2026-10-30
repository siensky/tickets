/**
 * Utloggning som delas av navbaren, "Mina biljetter" och checkout ("Inte du?"). Rensar först
 * den offline-cachade biljettlistan så att nästa användare på samma enhet inte ser den.
 */
import { useAuth0 } from '@auth0/auth0-react';
import { clearMyTicketsOfflineCache } from './clear-offline-cache.js';

export function useLogout(): () => void {
  const { logout } = useAuth0();
  return () => {
    void clearMyTicketsOfflineCache().then(() =>
      logout({ logoutParams: { returnTo: window.location.origin } }),
    );
  };
}
