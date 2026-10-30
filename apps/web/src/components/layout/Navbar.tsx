/**
 * Global navigering (docs/plan.md 7.11 A): ordmärket, kategorilänkar, sök, "Mina biljetter"
 * och inloggning/avatar-meny. Kategori och sök skriver till URL:ens query (`?category=`,
 * `?q=`), som startsidan läser, så en delad länk återskapar samma vy. Mobil: hamburgare
 * som öppnar en drawer.
 */
import { Menu } from 'lucide-react';
import { useState, type JSX, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { isEventCategory, type EventCategory } from '../../lib/categories.js';
import { Button } from '../ui/Button.js';
import { Container } from '../ui/Container.js';
import { Modal } from '../ui/Modal.js';
import { CategoryLinks } from './CategoryLinks.js';
import { SearchBox } from './SearchBox.js';
import { UserMenu } from './UserMenu.js';

export function Logo(): JSX.Element {
  return (
    <Link to="/" aria-label="tikknet, startsidan" className="shrink-0">
      <img
        src="/brand/tikknet-logo.svg"
        alt=""
        width={109}
        height={28}
        className="h-7 w-auto"
      />
    </Link>
  );
}

function MobileDrawer({
  open,
  onClose,
  activeCategory,
  query,
}: {
  open: boolean;
  onClose: () => void;
  activeCategory: EventCategory | null;
  query: string;
}): JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title="Meny" placement="drawer">
      <div className="flex flex-col gap-6" onClick={(event) => closeOnLink(event, onClose)}>
        <SearchBox key={query} initialQuery={query} onSubmitted={onClose} />
        <CategoryLinks activeCategory={activeCategory} orientation="vertical" />
        <UserMenu variant="drawer" />
      </div>
    </Modal>
  );
}

function closeOnLink(event: MouseEvent, onClose: () => void): void {
  if (event.target instanceof Element && event.target.closest('a') !== null) {
    onClose();
  }
}

export function Navbar(): JSX.Element {
  const [searchParams] = useSearchParams();
  const rawCategory = searchParams.get('category');
  const activeCategory = isEventCategory(rawCategory) ? rawCategory : null;
  const query = searchParams.get('q') ?? '';
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-base-300 bg-base-100/95 backdrop-blur">
      <Container className="flex h-16 items-center gap-4 lg:gap-8">
        <Button
          variant="ghost"
          className="min-w-11 lg:hidden"
          aria-label="Öppna menyn"
          onClick={() => setIsDrawerOpen(true)}
        >
          <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <Logo />
        <nav aria-label="Kategorier" className="hidden lg:block">
          <CategoryLinks activeCategory={activeCategory} />
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden w-72 sm:block">
            <SearchBox key={query} initialQuery={query} />
          </div>
          <div className="hidden lg:block">
            <UserMenu variant="bar" />
          </div>
        </div>
      </Container>
      <MobileDrawer
        open={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        activeCategory={activeCategory}
        query={query}
      />
    </header>
  );
}
