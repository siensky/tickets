/**
 * Köhändelserna (docs/plan.md 7.7): `queue_joined`, `queue_admitted {wait_seconds}` och
 * `queue_left {wait_seconds}` (lämnade innan insläpp). Väntetiden räknas från att den här
 * skärmen faktiskt ställde användaren i kön; en återupptagen kö (token i lagringen efter
 * omladdning) ger inga händelser eftersom starttiden då är okänd. Hookarna för själva kön
 * (`useQueueAdmission`) är orörda.
 */
import type { EventContext } from '@tickets/analytics';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { track } from '../../lib/analytics.js';
import type { QueueStatusResult } from '../../lib/api-client.js';
import { useEventContext } from '../analytics/use-event-context.js';
import { useTrackOnce } from '../analytics/use-track-once.js';

interface QueueRefs {
  readonly startedAt: MutableRefObject<number | undefined>;
  readonly hasJoinedRef: MutableRefObject<boolean>;
  readonly isAdmittedSent: MutableRefObject<boolean>;
  readonly contextRef: MutableRefObject<EventContext | undefined>;
}

/** `queue_left`: skärmen lämnas (eller fliken stängs) efter en lyckad join men före insläpp. */
function useTrackQueueLeft(refs: QueueRefs): void {
  const isLeftSent = useRef(false);
  useEffect(() => {
    isLeftSent.current = false;
    function leave(): void {
      const start = refs.startedAt.current;
      const current = refs.contextRef.current;
      if (!refs.hasJoinedRef.current || start === undefined || current === undefined) {
        return;
      }
      if (refs.isAdmittedSent.current || isLeftSent.current) {
        return;
      }
      isLeftSent.current = true;
      track('queue_left', { ...current, wait_seconds: secondsSince(start) });
    }
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);
}

export function useQueueAnalytics(
  eventId: string,
  isJoining: boolean,
  status: QueueStatusResult | undefined,
): void {
  const context = useEventContext(eventId);
  const contextRef = useRef(context);
  contextRef.current = context;
  // `startedAt` sätts när skärmen försöker gå med; `hasJoinedRef` först när kön svarat (status
  // finns), så ett misslyckat försök (429, stängd försäljning) varken räknas som join eller left.
  const startedAt = useRef<number | undefined>(undefined);
  const hasJoinedRef = useRef(false);
  const isAdmittedSent = useRef(false);
  const [hasJoined, setHasJoined] = useState(false);
  const isAdmitted = status?.status === 'admitted';

  useEffect(() => {
    if (isJoining && startedAt.current === undefined) {
      startedAt.current = Date.now();
    }
  }, [isJoining]);

  useEffect(() => {
    if (status !== undefined && startedAt.current !== undefined && !hasJoinedRef.current) {
      hasJoinedRef.current = true;
      setHasJoined(true);
    }
  }, [status]);

  useTrackOnce('queue_joined', hasJoined ? context : undefined);

  useEffect(() => {
    if (isAdmitted && hasJoined && context !== undefined && !isAdmittedSent.current) {
      const start = startedAt.current;
      if (start !== undefined) {
        isAdmittedSent.current = true;
        track('queue_admitted', { ...context, wait_seconds: secondsSince(start) });
      }
    }
  }, [isAdmitted, hasJoined, context]);

  useTrackQueueLeft({ startedAt, hasJoinedRef, isAdmittedSent, contextRef });
}

function secondsSince(start: number): number {
  return Math.round((Date.now() - start) / 1000);
}
