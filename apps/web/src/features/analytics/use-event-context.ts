/**
 * `event_id` + `category`, de gemensamma props för klienthändelserna (docs/plan.md 7.7). Delar
 * react-querys cache med eventsidan (`['event', id]`), så det blir inget extra anrop när
 * eventet redan hämtats. `undefined` tills eventet laddats.
 */
import type { EventContext } from '@tickets/analytics';
import { useQuery } from '@tanstack/react-query';
import { getEvent } from '../../lib/api-client.js';

export function useEventContext(eventId: string, enabled = true): EventContext | undefined {
  const { data } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: enabled && eventId !== '',
  });
  return data === undefined ? undefined : { event_id: data.id, category: data.category };
}
