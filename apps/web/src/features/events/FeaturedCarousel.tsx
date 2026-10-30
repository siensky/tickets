/**
 * Hero-karusellen med utvalda event (docs/plan.md 7.11 A). Ingen autoplay (planen: av som
 * default). Pilar på var sin sida, prickar och tangentbord (←/→). Gradient-overlay håller texten läsbar över bilden.
 */
import useEmblaCarousel from 'embla-carousel-react';
import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass } from '../../components/ui/Button.js';
import { Container } from '../../components/ui/Container.js';
import type { EventSummary } from '../../lib/api-client.js';
import { formatEventDate } from '../../lib/format.js';
import { CarouselControls } from './CarouselControls.js';
import { EventImage } from './EventImage.js';

const MAX_SLIDES = 5;

function Slide({
  event,
  index,
  total,
}: {
  event: EventSummary;
  index: number;
  total: number;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-roledescription="slide"
      aria-label={`${index + 1} av ${total}`}
      className="min-w-0 flex-[0_0_100%]"
    >
      <EventImage
        event={event}
        className="aspect-[4/5] sm:aspect-[16/9] lg:aspect-[21/9]"
        eager={index === 0}
        iconPosition="top-right"
      >
        <div className="absolute inset-0 bg-gradient-to-t from-neutral via-neutral/60 to-neutral/10" />
        <Container className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-3 pb-16 text-neutral-content sm:pb-14">
          <p className="label-caps">{formatEventDate(event.startsAt)}</p>
          <h2 className="display-heading max-w-3xl text-neutral-content">{event.title}</h2>
          <p className="text-lg">
            {event.artist} · {event.venueName}, {event.venueCity}
          </p>
          <Link to={`/events/${event.id}`} className={buttonClass('primary', 'lg')}>
            Köp biljetter
            <span className="sr-only"> till {event.title}</span>
          </Link>
        </Container>
      </EventImage>
    </div>
  );
}

function useCarouselState(slideCount: number) {
  const [viewportRef, embla] = useEmblaCarousel({ loop: true });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (embla === undefined) {
      return undefined;
    }
    const sync = (): void => setSelected(embla.selectedScrollSnap());
    sync();
    embla.on('select', sync);
    return () => {
      embla.off('select', sync);
    };
  }, [embla, slideCount]);

  return { viewportRef, embla, selected };
}

export function FeaturedCarousel({
  events,
}: {
  events: readonly EventSummary[];
}): JSX.Element {
  const slides = events.slice(0, MAX_SLIDES);
  const { viewportRef, embla, selected } = useCarouselState(slides.length);

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      embla?.scrollPrev();
    } else if (event.key === 'ArrowRight') {
      embla?.scrollNext();
    }
  }

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Utvalda evenemang"
      className="relative"
      onKeyDown={handleKeyDown}
    >
      <div ref={viewportRef} className="overflow-hidden">
        <div className="flex">
          {slides.map((event, index) => (
            <Slide key={event.id} event={event} index={index} total={slides.length} />
          ))}
        </div>
      </div>
      <CarouselControls
        count={slides.length}
        selected={selected}
        onPrev={() => embla?.scrollPrev()}
        onNext={() => embla?.scrollNext()}
        onGoTo={(index) => embla?.scrollTo(index)}
      />
    </section>
  );
}
