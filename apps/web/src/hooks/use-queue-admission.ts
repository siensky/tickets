/**
 * Joins the waiting room once and follows admission status (docs/plan.md
 * "Väntrum"). The token survives a reload via queue-token-storage.ts —
 * rejoining on every mount would hand out a new queue position each
 * time instead of resuming the existing one.
 *
 * Admission arrives over WebSocket (scheduler-worker publishes `admitted`,
 * `sales_closed` and `sold_out` to `ws:<kötoken>`): a message triggers an
 * immediate status read, so the page never trusts the socket alone. While the
 * socket is up, polling is only a slow fallback (every 15 s or the server's
 * `nextPollSeconds`, whichever is longer) for a missed message; every
 * (re)connect reads the status at once (docs/loadtest-cpu-plan.md steg 3).
 * While it is down the page follows the server's `nextPollSeconds`, never
 * faster than every 5 s, spread ±20 % so that everyone who lost their socket
 * at once doesn't ask at once. The old fixed 2 s without a socket was what made
 * the spike test 7/11 collapse: an overloaded ingress dropped sockets, every
 * dropped socket polled every 2 s, and that made the overload worse.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getQueueStatus, type QueueStatusResult } from '../lib/api-client.js';
import { joinQueueWithChallenge } from '../lib/challenge.js';
import { getStoredQueueToken, storeQueueToken } from '../lib/queue-token-storage.js';
import { retryWhileBusy } from '../lib/retry-while-busy.js';
import { useQueueSocket } from './use-queue-socket.js';

export const WAITING_FALLBACK_POLL_MS = 15_000;
export const WAITING_MIN_POLL_MS = 5000;
const POLL_JITTER = 0.2;
const QUEUE_MESSAGE_TYPES = new Set(['admitted', 'sales_closed', 'sold_out']);

/** Nästa statusfråga för den som väntar: serverns intervall, aldrig under golvet, med spridning. */
export function waitingPollDelayMs(
  isSocketOpen: boolean,
  serverNextPollSeconds: number | undefined,
): number {
  const serverMs = (serverNextPollSeconds ?? 0) * 1000;
  const floorMs = isSocketOpen ? WAITING_FALLBACK_POLL_MS : WAITING_MIN_POLL_MS;
  const baseMs = Math.max(floorMs, serverMs);
  return Math.round(baseMs * (1 - POLL_JITTER + Math.random() * 2 * POLL_JITTER));
}

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
      const data = query.state.data;
      if (data?.status === 'admitted') {
        return ADMITTED_KEEPALIVE_INTERVAL_MS;
      }
      return waitingPollDelayMs(
        isSocketOpen,
        data?.status === 'waiting' ? data.nextPollSeconds : undefined,
      );
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
