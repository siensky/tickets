/** Hero på eventsidan: bild med gradient-overlay, titel och artist. */
import type { JSX } from 'react';
import { Container } from '../../components/ui/Container.js';
import type { EventSummary } from '../../lib/api-client.js';
import { CATEGORY_LABELS } from '../../lib/categories.js';
import { EventImage } from './EventImage.js';

export function EventHero({ event }: { event: EventSummary }): JSX.Element {
  return (
    <EventImage
      event={event}
      eager
      iconPosition="top-right"
      className="aspect-[4/3] sm:aspect-[16/7]"
    >
      <div className="absolute inset-0 bg-gradient-to-t from-neutral via-neutral/50 to-transparent" />
      <Container className="absolute inset-x-0 bottom-0 pb-6 text-neutral-content sm:pb-10">
        <p className="label-caps">{CATEGORY_LABELS[event.category]}</p>
        <h1 className="display-heading text-neutral-content">{event.title}</h1>
        <p className="mt-1 text-lg">{event.artist}</p>
      </Container>
    </EventImage>
  );
}
