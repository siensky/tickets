/**
 * Joins the waiting room once and follows admission status (docs/plan.md
 * "Väntrum"). The token survives a reload via queue-token-storage.ts —
 * rejoining on every mount would hand out a new queue position each
 * time instead of resuming the existing one.
 *
 * Admission arrives over WebSocket (scheduler-worker publishes `admitted`,
 * `sales_closed` and `sold_out` to `ws:<kötoken>`): a message triggers an
 * immediate status read, so the page never trusts the socket alone. While the
 * socket is up, polling is only a slow fallback (every 15 s) for a missed
 * message; while it is down (no gateway, reconnecting) the page polls every
 * 2 s as before, and every (re)connect reads the status at once
 * (docs/loadtest-cpu-plan.md steg 3). Polling every 2 s for everyone was what
 * made a large queue cost tens of thousands of requests per second.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getQueueStatus, type QueueStatusResult } from '../lib/api-client.js';
import { joinQueueWithChallenge } from '../lib/challenge.js';
import { getStoredQueueToken, storeQueueToken } from '../lib/queue-token-storage.js';
import { retryWhileBusy } from '../lib/retry-while-busy.js';
import { useQueueSocket } from './use-queue-socket.js';

export const WAITING_FALLBACK_POLL_MS = 15_000;
export const WAITING_NO_SOCKET_POLL_MS = 2000;
const QUEUE_MESSAGE_TYPES = new Set(['admitted', 'sales_closed', 'sold_out']);

function isQueueMessage(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || !('type' in payload)) {
    return false;
  }
  return typeof payload.type === 'string' && QUEUE_MESSAGE_TYPES.has(payload.type);
}
// Once admitted, booking-api's GET /queue/status refreshes the
// admission's inactivity window server-side on every call
// (queue-service.ts's `touchAdmittedActivity`). Without SOME continued
// polling while the user is browsing the seatmap, that window (10 min
// default, docs/plan.md "Väntrum") could lapse and silently kick them
// back to the waiting room mid-checkout. 2 s is overkill once admitted
// — a slow keep-alive is enough.
const ADMITTED_KEEPALIVE_INTERVAL_MS = 60_000;

function useJoinQueueOnce(eventId: string): {
  token: string | undefined;
  isJoining: boolean;
  joinError: Error | undefined;
} {
  const [token, setToken] = useState<string | undefined>(() => getStoredQueueToken(eventId));
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<Error | undefined>();

  useEffect(() => {
    if (token !== undefined) {
      return undefined;
    }
    let cancelled = false;
    setIsJoining(true);
    // Ett 503 (alla databasanslutningar upptagna i toppen av en försäljning) försöks om några gånger.
    retryWhileBusy(() => joinQueueWithChallenge(eventId), { isCancelled: () => cancelled })
      .then((result) => {
        if (!cancelled) {
          storeQueueToken(eventId, result.token);
          setToken(result.token);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setJoinError(error instanceof Error ? error : new Error('failed to join queue'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsJoining(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, token]);

  return { token, isJoining, joinError };
}

/**
 * `listenForAdmission: false` på sidor där besökaren redan är insläppt (platskartan): de har en egen
 * socket för `seat_taken`, och en andra anslutning per besökare vore bara dubbel last på realtime-gateway.
 */
export function useQueueAdmission(
  eventId: string,
  { listenForAdmission = true }: { listenForAdmission?: boolean } = {},
): {
  token: string | undefined;
  status: QueueStatusResult | undefined;
  isJoining: boolean;
  error: Error | undefined;
} {
  const { token, isJoining, joinError } = useJoinQueueOnce(eventId);

  // Bara kösidan lyssnar; platskartan har redan sin egen socket för `seat_taken`.
  const refetchRef = useRef<() => void>(() => undefined);
  const isSocketOpen = useQueueSocket(
    listenForAdmission ? token : undefined,
    (payload) => {
      if (isQueueMessage(payload)) {
        refetchRef.current();
      }
    },
    () => refetchRef.current(),
  );
  // Läget är ett vanligt värde (inte en ref), så att TanStack räknar om intervallet så fort socketen
  // öppnas eller stängs, inte först vid nästa hämtning.
  const statusQuery = useQuery({
    queryKey: ['queue-status', eventId, token],
    queryFn: () => getQueueStatus(eventId, token ?? ''),
    enabled: token !== undefined,
    refetchInterval: (query) => {
      if (query.state.data?.status === 'admitted') {
        return ADMITTED_KEEPALIVE_INTERVAL_MS;
      }
      return isSocketOpen ? WAITING_FALLBACK_POLL_MS : WAITING_NO_SOCKET_POLL_MS;
    },
  });
  refetchRef.current = () => void statusQuery.refetch();

  return {
    token,
    status: statusQuery.data,
    isJoining,
    error: joinError ?? statusQuery.error ?? undefined,
  };
}
