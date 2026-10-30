/**
 * Sidramen: hoppa-till-innehåll-länk, offline-banner, navbar, `<main>` och notiser
 * (sonner, `aria-live`). Ingen footer: allt navigerbart ligger i navbaren.
 */
import type { JSX, ReactNode } from 'react';
import { Toaster } from 'sonner';
import { Navbar } from './Navbar.js';
import { OfflineBanner } from './OfflineBanner.js';

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-base-100 text-base-content">
      <a
        href="#main"
        className="btn btn-primary sr-only z-50 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Hoppa till innehållet
      </a>
      <OfflineBanner />
      <Navbar />
      <main id="main" className="flex-1">
        {children}
      </main>
      <Toaster position="top-center" closeButton />
    </div>
  );
}
