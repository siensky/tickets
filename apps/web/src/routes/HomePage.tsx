/**
 * Startsidan (docs/plan.md 7.11 A): hero-karusell med utvalda event, kategorichips och ett
 * grid med eventkort. Kategori och sök läses ur URL:ens query (navbaren skriver dit), så en
 * delad länk återskapar samma vy. Karusellen visas bara i den ofiltrerade vyn.
 */
import { useQuery } from '@tanstack/react-query';
import { SearchX } from 'lucide-react';
import type { JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { buttonClass } from '../components/ui/Button.js';
import { Container } from '../components/ui/Container.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { ErrorState } from '../components/ui/ErrorState.js';
import { Skeleton } from '../components/ui/Skeleton.js';
import { CategoryChips } from '../features/events/CategoryChips.js';
import { EventCard } from '../features/events/EventCard.js';
import { FeaturedCarousel } from '../features/events/FeaturedCarousel.js';
import { listEvents, type EventSummary } from '../lib/api-client.js';
import { CATEGORY_LABELS, isEventCategory, type EventCategory } from '../lib/categories.js';

function GridSkeleton(): JSX.Element {
  return (
    <div
      className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      aria-busy="true"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-96 rounded-box" />
      ))}
    </div>
  );
}

function headingFor(q: string | undefined, category: EventCategory | undefined): string {
  if (q !== undefined) {
    return `Sökresultat för "${q}"`;
  }
  return category === undefined ? 'Alla evenemang' : CATEGORY_LABELS[category];
}

function EventGrid({ events }: { events: readonly EventSummary[] }): JSX.Element {
  if (events.length === 0) {
    return (
      <EmptyState icon={SearchX} title="Inga evenemang hittades">
        Prova en annan kategori eller ett annat sökord.
        <div className="mt-4">
          <Link to="/" className={buttonClass('secondary')}>
            Visa alla evenemang
          </Link>
        </div>
      </EmptyState>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {events.map((event) => (
        <li key={event.id}>
          <EventCard event={event} />
        </li>
      ))}
    </ul>
  );
}

export function HomePage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const rawCategory = searchParams.get('category');
  const category = isEventCategory(rawCategory) ? rawCategory : undefined;
  const q = searchParams.get('q') ?? undefined;

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['events', { category, q }],
    queryFn: () => listEvents({ category, q }),
  });
  const featured = data?.events.filter((event) => event.featured) ?? [];
  const showCarousel = category === undefined && q === undefined && featured.length > 0;

  return (
    <>
      {showCarousel ? (
        <>
          <h1 className="sr-only">{headingFor(q, category)}</h1>
          <FeaturedCarousel events={featured} />
        </>
      ) : null}
      <Container className="flex flex-col gap-6 py-10 lg:py-14">
        {showCarousel ? null : <h1 className="text-3xl">{headingFor(q, category)}</h1>}
        <CategoryChips activeCategory={category} />
        {isPending ? <GridSkeleton /> : null}
        {isError ? (
          <ErrorState message="Kunde inte hämta evenemang." onRetry={() => void refetch()} />
        ) : null}
        {data === undefined ? null : <EventGrid events={data.events} />}
      </Container>
    </>
  );
}
