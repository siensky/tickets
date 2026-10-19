/**
 * Shared TanStack Query client (docs/forsvar.md "Varför TanStack Query
 * istället för egen polling?"). The seatmap's 2s polling will use
 * `refetchInterval`, and TanStack Query already pauses polling when the
 * tab is hidden — the detail that keeps 20 000 background tabs from
 * hammering the API.
 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
});
