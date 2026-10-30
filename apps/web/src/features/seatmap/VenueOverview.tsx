/**
 * Arenaöversikten (docs/plan.md 7.11 D steg 1): kartan (VenueMap) med scenen och sektionerna
 * utritade från backendens `layout`. Saknar någon sektion layout
 * (t.ex. lasttestarenan) visas sektionerna som ett rutnät av kort i stället.
 */
import type { JSX } from 'react';
import { Badge } from '../../components/ui/Badge.js';
import { Card } from '../../components/ui/Card.js';
import type { SectionSummary, SectionSummaryEntry } from '../../lib/api-client.js';
import { formatPriceRange } from '../../lib/format.js';
import { AVAILABILITY_LABEL } from './SectionShape.js';
import { VenueMap } from './VenueMap.js';

const BADGE_TONE = { on_sale: 'success', few_left: 'warning', sold_out: 'ghost' } as const;

function SectionCards({
  sections,
  onSelect,
}: {
  sections: readonly SectionSummaryEntry[];
  onSelect: (sectionId: string) => void;
}): JSX.Element {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {sections.map((section) => {
        const isSoldOut = section.availability === 'sold_out';
        const price = formatPriceRange(section.minPriceCents, section.maxPriceCents);
        return (
          <li key={section.id}>
            <button
              type="button"
              disabled={isSoldOut}
              onClick={() => onSelect(section.id)}
              className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Card interactive={!isSoldOut} className="flex flex-col gap-2">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-lg font-semibold">{section.name}</span>
                  <Badge tone={BADGE_TONE[section.availability]}>
                    {AVAILABILITY_LABEL[section.availability]}
                  </Badge>
                </span>
                <span className="text-sm text-muted tabular-nums">
                  {isSoldOut ? 'Inga platser kvar' : `${section.availableCount} platser kvar`}
                  {price === '' ? '' : ` · ${price}`}
                </span>
              </Card>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function VenueOverview({
  summary,
  onSelect,
}: {
  summary: SectionSummary;
  onSelect: (sectionId: string) => void;
}): JSX.Element {
  const hasLayout = summary.sections.every((section) => section.layout !== null);
  if (!hasLayout) {
    return <SectionCards sections={summary.sections} onSelect={onSelect} />;
  }
  return <VenueMap summary={summary} onSelect={onSelect} />;
}
