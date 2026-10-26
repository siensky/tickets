/**
 * "Välj evenemang" (docs/plan.md "Domän och användarflöde"). Public,
 * no queue token needed yet.
 */
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { listEvents } from '../lib/api-client.js';

export function EventsListPage(): JSX.Element {
  const { data, isPending, isError } = useQuery({
    queryKey: ['events'],
    queryFn: listEvents,
  });

  if (isPending) {
    return <p>Laddar evenemang…</p>;
  }
  if (isError) {
    return <p role="alert">Kunde inte hämta evenemang. Försök igen senare.</p>;
  }

  return (
    <section>
      <h1>Evenemang</h1>
      {data.events.length === 0 ? (
        <p>Inga evenemang just nu.</p>
      ) : (
        <ul>
          {data.events.map((event) => (
            <li key={event.id}>
              <Link to={`/events/${event.id}`}>
                {event.title} — {event.artist} ({event.venueName}, {event.venueCity})
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
