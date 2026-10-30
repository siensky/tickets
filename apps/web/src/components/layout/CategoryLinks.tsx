/** Kategorilänkar i navbaren och drawern. Aktiv kategori markeras med `aria-current`. */
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  CATEGORY_LABELS,
  EVENT_CATEGORIES,
  type EventCategory,
} from '../../lib/categories.js';

export function CategoryLinks({
  activeCategory,
  orientation = 'horizontal',
}: {
  activeCategory: EventCategory | null;
  orientation?: 'horizontal' | 'vertical';
}): JSX.Element {
  const layout = orientation === 'vertical' ? 'flex-col items-stretch' : 'items-center gap-1';
  return (
    <ul className={`flex ${layout}`}>
      {EVENT_CATEGORIES.map((category) => {
        const isActive = activeCategory === category;
        return (
          <li key={category}>
            <Link
              to={`/?category=${category}`}
              aria-current={isActive ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-field px-3 text-sm font-medium transition-colors ${
                isActive ? 'bg-base-200 text-primary' : 'hover:bg-base-200'
              }`}
            >
              {CATEGORY_LABELS[category]}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
