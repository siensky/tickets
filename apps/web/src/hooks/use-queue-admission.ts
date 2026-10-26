/**
 * Joins the waiting room once and polls admission status (docs/plan.md
 * "Väntrum"). The token survives a reload via queue-token-storage.ts —
 * rejoining on every mount would hand out a new queue position each
 * time instead of resuming the existing one.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getQueueStatus, joinQueue, type QueueStatusResult } from '../lib/api-client.js';
import { getStoredQueueToken, storeQueueToken } from '../lib/queue-token-storage.js';

const POLL_INTERVAL_MS = 2000;
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
    joinQueue(eventId)
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

export function useQueueAdmission(eventId: string): {
  token: string | undefined;
  status: QueueStatusResult | undefined;
  isJoining: boolean;
  error: Error | undefined;
} {
  const { token, isJoining, joinError } = useJoinQueueOnce(eventId);

  const statusQuery = useQuery({
    queryKey: ['queue-status', eventId, token],
    queryFn: () => getQueueStatus(eventId, token ?? ''),
    enabled: token !== undefined,
    refetchInterval: (query) =>
      query.state.data?.status === 'admitted'
        ? ADMITTED_KEEPALIVE_INTERVAL_MS
        : POLL_INTERVAL_MS,
  });

  return {
    token,
    status: statusQuery.data,
    isJoining,
    error: joinError ?? statusQuery.error ?? undefined,
  };
}
