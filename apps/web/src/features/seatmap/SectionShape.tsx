/**
 * En sektion i arenaöversikten. Tillgänglighet visas med mönster, inte bara färg: ledig =
 * ljus grön fyllning, få kvar = amber randning, slutsåld = grå med kors. Klick, Enter eller
 * mellanslag öppnar sektionen.
 */
import type { JSX, KeyboardEvent } from 'react';
import type { SectionLayout, SectionSummaryEntry } from '../../lib/api-client.js';
import { formatPriceRange } from '../../lib/format.js';

export const AVAILABILITY_LABEL = {
  on_sale: 'Platser kvar',
  few_left: 'Få platser kvar',
  sold_out: 'Slutsåld',
} as const;

const FILL_CLASS = {
  on_sale: 'fill-accent',
  few_left: 'fill-accent',
  sold_out: 'fill-muted',
} as const;

// Mönster ovanpå fyllningen så att status aldrig bärs av färg ensam: få kvar = ljusa
// diagonaler, slutsåld = grå med kors.
const OVERLAY_PATTERN = {
  on_sale: undefined,
  few_left: 'url(#sec-few)',
  sold_out: 'url(#sec-sold)',
} as const;

export function sectionAriaLabel(section: SectionSummaryEntry): string {
  if (section.availability === 'sold_out') {
    return `${section.name}, slutsåld`;
  }
  const price = formatPriceRange(section.minPriceCents, section.maxPriceCents);
  // Etiketten innehåller den synliga texten ("3 kvar"), annars bryter den mot WCAG 2.5.3.
  return `${section.name}, ${section.availableCount} kvar${price === '' ? '' : `, ${price}`}`;
}

/** Namnet i versaler mitt i sektionen. Detaljerna (pris, platser kvar) visas i tooltipen. */
function SectionLabel({
  section,
  cx,
  cy,
  maxWidth,
}: {
  section: SectionSummaryEntry;
  cx: number;
  cy: number;
  maxWidth: number;
}): JSX.Element {
  // Texten krymper så att långa namn ryms i smala sektioner (ungefär 0,68 em per versal).
  const fontSize = Math.min(30, (maxWidth - 24) / (section.name.length * 0.68));
  return (
    <text
      className="fill-base-100"
      x={cx}
      y={cy}
      dominantBaseline="central"
      textAnchor="middle"
      fontSize={fontSize}
      fontWeight={600}
      letterSpacing={1}
      aria-hidden="true"
    >
      {section.name.toUpperCase()}
    </text>
  );
}

function SectionBody({
  layout,
  availability,
}: {
  layout: SectionLayout;
  availability: SectionSummaryEntry['availability'];
}): JSX.Element {
  const overlay = OVERLAY_PATTERN[availability];
  return (
    <>
      <rect
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        rx={14}
        className={`${FILL_CLASS[availability]} stroke-base-300`}
        strokeWidth={6}
      />
      {overlay === undefined ? null : (
        <rect
          x={layout.x}
          y={layout.y}
          width={layout.width}
          height={layout.height}
          rx={14}
          fill={overlay}
          pointerEvents="none"
        />
      )}
    </>
  );
}

export function SectionShape({
  section,
  layout,
  onSelect,
  onHover,
}: {
  section: SectionSummaryEntry;
  layout: SectionLayout;
  onSelect: (sectionId: string) => void;
  onHover: (section: SectionSummaryEntry | undefined) => void;
}): JSX.Element {
  const isSoldOut = section.availability === 'sold_out';
  const cx = layout.x + layout.width / 2;
  const cy = layout.y + layout.height / 2;

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isSoldOut) {
        onSelect(section.id);
      }
    }
  }

  return (
    <g
      role="button"
      data-section-id={section.id}
      tabIndex={0}
      aria-disabled={isSoldOut || undefined}
      aria-label={sectionAriaLabel(section)}
      transform={`rotate(${layout.rotation} ${cx} ${cy})`}
      className={isSoldOut ? 'cursor-not-allowed' : 'cursor-pointer hover:opacity-85'}
      onClick={() => (isSoldOut ? undefined : onSelect(section.id))}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => onHover(section)}
      onPointerLeave={() => onHover(undefined)}
      onFocus={() => onHover(section)}
      onBlur={() => onHover(undefined)}
    >
      <SectionBody layout={layout} availability={section.availability} />
      <SectionLabel section={section} cx={cx} cy={cy} maxWidth={layout.width} />
    </g>
  );
}
