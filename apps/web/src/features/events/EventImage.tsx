/**
 * Eventbilden i fast bildförhållande (layouten hoppar inte), eller en gradient i primärfärgen
 * med kategorins ikon när bild saknas (docs/plan.md 7.11 A).
 */
import { useState, type JSX, type ReactNode } from 'react';
import type { EventSummary } from '../../lib/api-client.js';
import { CATEGORY_ICONS } from './category-icons.js';

export function EventImage({
  event,
  className = 'aspect-video',
  eager = false,
  iconPosition = 'center',
  children,
}: {
  event: Pick<EventSummary, 'imageUrl' | 'category'>;
  className?: string;
  eager?: boolean;
  /** I heron ligger texten över bilden, så ikonen flyttas ur vägen. */
  iconPosition?: 'center' | 'top-right';
  children?: ReactNode;
}): JSX.Element {
  const Icon = CATEGORY_ICONS[event.category];
  // Laddar bilden inte (cdn nere, fel adress) visas samma gradient som när bild saknas.
  const [hasFailed, setHasFailed] = useState(false);
  return (
    <div className={`relative w-full overflow-hidden bg-neutral ${className}`}>
      {event.imageUrl === null || hasFailed ? (
        <div
          className={`flex h-full w-full bg-gradient-to-br from-primary to-neutral text-primary-content ${
            iconPosition === 'center'
              ? 'items-center justify-center'
              : 'justify-end p-6 sm:p-10'
          }`}
        >
          <Icon size={48} strokeWidth={1.75} aria-hidden="true" className="opacity-60" />
        </div>
      ) : (
        <img
          src={event.imageUrl}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setHasFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
      {children}
    </div>
  );
}
