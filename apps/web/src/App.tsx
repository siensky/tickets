import type { JSX } from 'react';

/**
 * Root component. Routing (events, waiting room, seat map, checkout,
 * my tickets) is built out in Fas 5 — this is the bootable shell that
 * proves the toolchain (React 19, TanStack Query, Vite) works end to end.
 */
export function App(): JSX.Element {
  return (
    <main>
      <h1>Tickets</h1>
      <p>Skeleton — bokningsflödet byggs i Fas 5 (se docs/plan.md).</p>
    </main>
  );
}
