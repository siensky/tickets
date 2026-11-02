/** `event_viewed`: en gång per event som visas på eventsidan. */
import type { EventSummary } from '../../lib/api-client.js';
import { useTrackOnce } from './use-track-once.js';

export function useTrackEventViewed(event: EventSummary | undefined): void {
  useTrackOnce(
    'event_viewed',
    event === undefined ? undefined : { event_id: event.id, category: event.category },
  );
}
