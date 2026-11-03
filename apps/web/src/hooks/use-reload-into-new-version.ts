/**
 * Laddar in en ny version av appen vid nästa sidbyte (se lib/service-worker-registration.ts). Ett
 * sidbyte är en säker tidpunkt: föregående sidas anrop är klara (bokningen navigerar först när
 * reservationen sparats), och den nya sidans läge finns i URL:en, localStorage och sessionStorage.
 * Anrop som den nya sidan själv startar när den visas (kartans och avbrytsidans avbokning) kan avbrytas
 * av omladdningen, men de körs om efter den: båda är idempotenta, och kartan glömmer sin reservation
 * först när avbokningen gått igenom.
 * Aldrig medan Auth0:s återkomst (`code` + `state`) ligger i adressfältet: den koden går bara att
 * växla in en gång, så en omladdning mitt i den loggar ut kunden. Auth0 navigerar själv bort från
 * den när inloggningen är klar, och det sidbytet laddar då in den nya versionen.
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { isNewVersionReady } from '../lib/service-worker-registration.js';

function isAuthCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('code') && params.has('state');
}

export function useReloadIntoNewVersion(
  isReady: () => boolean = isNewVersionReady,
  reload: () => void = () => window.location.reload(),
): void {
  const { pathname, search } = useLocation();
  // Senaste värdena utan att de blir beroenden: bara ett nytt sidbyte (ny sökväg) ska trigga.
  const latest = useRef({ search, isReady, reload });
  latest.current = { search, isReady, reload };
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const current = latest.current;
    if (current.isReady() && !isAuthCallback(current.search)) {
      current.reload();
    }
  }, [pathname]);
}
