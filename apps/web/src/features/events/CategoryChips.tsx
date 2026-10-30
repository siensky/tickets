/** Kategorichips ovanför eventgridet: "Alla" + de fyra kategorierna, via `?category=`. */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  CATEGORY_LABELS,
  EVENT_CATEGORIES,
  type EventCategory,
} from '../../lib/categories.js';
import { CATEGORY_ICONS } from './category-icons.js';

function chipClass(isActive: boolean): string {
  return `inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors ${
    isActive
      ? 'border-neutral bg-neutral text-neutral-content'
      : 'border-base-300 bg-base-100 hover:bg-base-200'
  }`;
}

export function CategoryChips({
  activeCategory,
}: {
  activeCategory: EventCategory | undefined;
}): JSX.Element {
  return (
    <nav aria-label="Filtrera på kategori">
      <ul className="flex flex-wrap gap-2">
        <li>
          <Link
            to="/"
            className={chipClass(activeCategory === undefined)}
            aria-current={activeCategory === undefined ? 'page' : undefined}
          >
            Alla
          </Link>
        </li>
        {EVENT_CATEGORIES.map((category) => {
          const Icon = CATEGORY_ICONS[category];
          return (
            <li key={category}>
              <Link
                to={`/?category=${category}`}
                className={chipClass(activeCategory === category)}
                aria-current={activeCategory === category ? 'page' : undefined}
              >
                <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                {CATEGORY_LABELS[category]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
