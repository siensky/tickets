/** Global banner när webbläsaren saknar nätverk (docs/plan.md 7.11 "Nätverk nere"). */
import { WifiOff } from 'lucide-react';
import { useSyncExternalStore, type JSX } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useIsOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

export function OfflineBanner(): JSX.Element | null {
  if (useIsOnline()) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-neutral px-4 py-2 text-sm text-neutral-content"
    >
      <WifiOff size={16} strokeWidth={1.75} aria-hidden="true" />
      Du är offline. Bokning kräver internet, men Mina biljetter fungerar.
    </div>
  );
}
