/**
 * Global navigering (docs/plan.md Fas 6: "Navbar med kategorier ...
 * sökfält, inloggningsknapp"). Kategoriknapparna och sökfältet skriver
 * till URL:ens query-sträng (`useSearchParams`) i stället för lokalt
 * state — HomePage läser SAMMA query-sträng, så en delad/bokmärkt länk
 * (`/?category=sport`) återskapar exakt samma filter utan någon extra
 * kod.
 *
 * Mobile first: kategorierna radbryts under toppraden på smala skärmar
 * (`flex-wrap`) i stället för en separat hamburgermeny — tillräckligt
 * för fyra kategorier, inte motiverat att bygga en till
 * navigeringskomponent för.
 */
import { useAuth0 } from '@auth0/auth0-react';
import type { FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isAuth0Configured } from '../lib/auth-provider.js';
import {
  CATEGORY_LABELS,
  EVENT_CATEGORIES,
  isEventCategory,
  type EventCategory,
} from '../lib/categories.js';

function CategoryLinks({
  activeCategory,
}: {
  activeCategory: EventCategory | undefined;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1 text-sm font-medium">
      {EVENT_CATEGORIES.map((category) => (
        <Link
          key={category}
          to={`/?category=${category}`}
          className={`rounded-full px-3 py-1 transition-colors ${
            activeCategory === category
              ? 'bg-brand-red text-paper'
              : 'text-paper/90 hover:bg-paper/10'
          }`}
        >
          {CATEGORY_LABELS[category]}
        </Link>
      ))}
    </div>
  );
}

function SearchBox({ initialQuery }: { initialQuery: string }): JSX.Element {
  const navigate = useNavigate();
  // `useState(initialQuery)` bara seedar INITIALA värdet — en kategori-
  // länk eller ett bakåt-klick som ändrar `?q=` i URL:en utan att den
  // här komponenten avmonteras hade annars lämnat fältet visande den
  // GAMLA söktexten (upptäckt i Fas 6-reviewn). Löst i Navbar() nedan
  // med `key={initialQuery}` istället för en useEffect-synk — enklare,
  // och gör precis det en key alltid gör: monterar om komponenten (och
  // därmed dess state) när propen den är nyckad på ändras.
  const [value, setValue] = useState(initialQuery);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = value.trim();
    void navigate(trimmed.length > 0 ? `/?q=${encodeURIComponent(trimmed)}` : '/');
  }

  return (
    <form onSubmit={handleSubmit} role="search" className="w-full max-w-xs">
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Sök evenemang eller artist…"
        aria-label="Sök evenemang"
        className="w-full rounded-full border border-transparent bg-paper px-4 py-1.5 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent-blue"
      />
    </form>
  );
}

function LoginButton(): JSX.Element | null {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();
  if (!isAuth0Configured || isLoading) {
    return null;
  }
  if (isAuthenticated) {
    return (
      <Link
        to="/my-tickets"
        className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink hover:bg-muted-light"
      >
        Mina biljetter
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={() =>
        void loginWithRedirect({ appState: { returnTo: window.location.pathname } })
      }
      className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink hover:bg-muted-light"
    >
      Logga in
    </button>
  );
}

export function Navbar(): JSX.Element {
  const [searchParams] = useSearchParams();
  const activeCategory = searchParams.get('category');
  const q = searchParams.get('q') ?? '';

  return (
    <header className="bg-ink text-paper">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center justify-between gap-4 md:justify-start">
          <Link to="/" className="text-xl font-extrabold tracking-tight">
            TICKET<span className="text-brand-red">HUB</span>
          </Link>
          <div className="md:hidden">
            <LoginButton />
          </div>
        </div>
        <CategoryLinks
          activeCategory={isEventCategory(activeCategory) ? activeCategory : undefined}
        />
        <div className="flex items-center gap-3">
          <SearchBox key={q} initialQuery={q} />
          <div className="hidden md:block">
            <LoginButton />
          </div>
        </div>
      </div>
    </header>
  );
}
