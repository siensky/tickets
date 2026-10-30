/**
 * Arenakartan i koordinatsystemet 0–1000 × 0–700 (docs/plan.md 7.11 D, E2/E3): en grå arenasilhuett
 * med scenen och sektionerna ovanpå. Sektionerna är blå med versal text. Hovrar eller fokuserar man
 * en sektion visas en tooltip med "Från X kr" och antal platser kvar.
 */
import { useState, type JSX } from 'react';
import type { SectionSummary, SectionSummaryEntry } from '../../lib/api-client.js';
import { formatPrice } from '../../lib/format.js';
import { SectionShape } from './SectionShape.js';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 700;
const SILHOUETTE_PADDING = 45;

function Patterns(): JSX.Element {
  return (
    <defs>
      <pattern id="sec-few" width="16" height="16" patternUnits="userSpaceOnUse">
        <path d="M-2,18 L18,-2" className="stroke-base-100/45" strokeWidth={4} />
      </pattern>
      <pattern id="sec-sold" width="18" height="18" patternUnits="userSpaceOnUse">
        <path d="M3,3 L15,15 M15,3 L3,15" className="stroke-base-100/50" strokeWidth={2} />
      </pattern>
    </defs>
  );
}

function boundsOf(summary: SectionSummary): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const boxes = [
    ...summary.sections.flatMap((section) =>
      section.layout === null ? [] : [section.layout],
    ),
    ...(summary.stage === null ? [] : [summary.stage]),
  ];
  // Hålls inom kartan (en liten marginal), annars klipps silhuetten av viewBox.
  const minX = Math.max(8, Math.min(...boxes.map((box) => box.x)) - SILHOUETTE_PADDING);
  const minY = Math.max(8, Math.min(...boxes.map((box) => box.y)) - SILHOUETTE_PADDING);
  const maxX = Math.min(
    VIEW_WIDTH - 8,
    Math.max(...boxes.map((box) => box.x + box.width)) + SILHOUETTE_PADDING,
  );
  const maxY = Math.min(
    VIEW_HEIGHT - 8,
    Math.max(...boxes.map((box) => box.y + box.height)) + SILHOUETTE_PADDING,
  );
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function SectionTooltip({ section }: { section: SectionSummaryEntry }): JSX.Element | null {
  if (section.layout === null) {
    return null;
  }
  const isSoldOut = section.availability === 'sold_out';
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-field bg-neutral px-3 py-2 text-center text-sm whitespace-nowrap text-neutral-content shadow-lg"
      style={{
        left: `${((section.layout.x + section.layout.width / 2) / VIEW_WIDTH) * 100}%`,
        top: `${((section.layout.y - 8) / VIEW_HEIGHT) * 100}%`,
      }}
    >
      <p className="font-semibold">{section.name}</p>
      <p className="tabular-nums">
        {isSoldOut || section.minPriceCents === null
          ? 'Slutsåld'
          : `Från ${formatPrice(section.minPriceCents)}`}
      </p>
      {isSoldOut ? null : (
        <p className="text-xs opacity-80">{section.availableCount} platser kvar</p>
      )}
    </div>
  );
}

function StageShape({ stage }: { stage: NonNullable<SectionSummary['stage']> }): JSX.Element {
  return (
    <g aria-hidden="true">
      <rect {...stage} rx={12} className="fill-muted" />
      <text
        x={stage.x + stage.width / 2}
        y={stage.y + stage.height / 2}
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={28}
        fontWeight={600}
        letterSpacing={3}
        className="fill-base-100"
      >
        SCEN
      </text>
    </g>
  );
}

export function VenueMap({
  summary,
  onSelect,
}: {
  summary: SectionSummary;
  onSelect: (sectionId: string) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState<SectionSummaryEntry | undefined>();
  const { stage } = summary;
  const silhouette = boundsOf(summary);
  return (
    <div className="relative mx-auto w-full max-w-4xl">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="group"
        aria-label="Arenakarta"
        className="h-auto w-full"
      >
        <Patterns />
        <rect {...silhouette} rx={60} className="fill-base-300" aria-hidden="true" />
        {stage === null ? null : <StageShape stage={stage} />}
        {summary.sections.map((section) =>
          section.layout === null ? null : (
            <SectionShape
              key={section.id}
              section={section}
              layout={section.layout}
              onSelect={onSelect}
              onHover={setHovered}
            />
          ),
        )}
      </svg>
      {hovered === undefined ? null : <SectionTooltip section={hovered} />}
    </div>
  );
}
