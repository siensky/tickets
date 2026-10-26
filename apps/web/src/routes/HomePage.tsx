/**
 * Startsidan (docs/plan.md Fas 6: "landningssida med utvalda konserter/
 * evenemang + utfyllnadsinnehåll, mobile first"). Ersätter den gamla
 * EventsListPage — samma data (GET /events), nu med en hero-sektion och
 * kategori/sök-filter läst direkt ur URL:ens query-sträng (Navbar
 * skriver dit, den här sidan bara läser), så en delad länk återskapar
 * samma vy.
 */
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EventCard } from '../components/EventCard.js';
import { listEvents } from '../lib/api-client.js';
import { isEventCategory, type EventCategory } from '../lib/categories.js';

function Hero(): JSX.Element {
  return (
    <div className="bg-ink px-4 py-16 text-center text-paper">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">
        Din biljett till <span className="text-brand-red">nästa stora kväll</span>
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-paper/80">
        Konserter, sport, teater och festivaler — bokade på sekunder, med platsval på en
        interaktiv arenakarta.
      </p>
    </div>
  );
}

function parseCategory(raw: string | null): EventCategory | undefined {
  return isEventCategory(raw) ? raw : undefined;
}

export function HomePage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const category = parseCategory(searchParams.get('category'));
  const q = searchParams.get('q') ?? undefined;

  const { data, isPending, isError } = useQuery({
    queryKey: ['events', { category, q }],
    queryFn: () => listEvents({ category, q }),
  });

  return (
    <>
      <Hero />
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h2 className="mb-6 text-2xl font-bold text-ink">
          {q !== undefined
            ? `Sökresultat för "${q}"`
            : category !== undefined
              ? 'Evenemang i vald kategori'
              : 'Utvalda evenemang'}
        </h2>
        {isPending ? (
          <p className="text-muted">Laddar evenemang…</p>
        ) : isError ? (
          <p role="alert" className="text-brand-red">
            Kunde inte hämta evenemang. Försök igen senare.
          </p>
        ) : data.events.length === 0 ? (
          <p className="text-muted">Inga evenemang matchade.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {data.events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
