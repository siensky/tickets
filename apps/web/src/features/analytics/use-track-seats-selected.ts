/** `seats_selected {seat_count}`: skickas när antalet valda stolar ändras till minst en. */
import { useEffect } from 'react';
import { track } from '../../lib/analytics.js';
import { useEventContext } from './use-event-context.js';

export function useTrackSeatsSelected(eventId: string, seatCount: number): void {
  const context = useEventContext(eventId);
  const contextEventId = context?.event_id;
  const contextCategory = context?.category;
  useEffect(() => {
    if (contextEventId !== undefined && contextCategory !== undefined && seatCount > 0) {
      track('seats_selected', {
        event_id: contextEventId,
        category: contextCategory,
        seat_count: seatCount,
      });
    }
  }, [seatCount, contextEventId, contextCategory]);
}
