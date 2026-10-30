/**
 * Bottenpanelen under `lg` (docs/plan.md 7.11 E): en minimerad rad "3 platser · 1 185 kr ·
 * Fortsätt". "Fortsätt" reserverar direkt; pilen expanderar till hela sammanfattningen i en
 * bottenpanel.
 */
import { ChevronUp } from 'lucide-react';
import { useState, type JSX } from 'react';
import { BottomSheet } from '../../components/ui/BottomSheet.js';
import { Button } from '../../components/ui/Button.js';
import { formatPrice } from '../../lib/format.js';
import {
  BookingSummaryPanel,
  sumPreliminary,
  type BookingSummaryProps,
} from './BookingSummaryPanel.js';

export function MobileSummaryBar(props: BookingSummaryProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const count = props.seats.length;
  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-base-300 bg-base-100 p-3 shadow-lg lg:hidden">
        <Button
          variant="ghost"
          className="flex-1 justify-start"
          aria-label="Visa sammanfattning"
          onClick={() => setIsExpanded(true)}
        >
          <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="tabular-nums">
            {count === 0
              ? 'Inga platser valda'
              : `${count} ${count === 1 ? 'plats' : 'platser'} · ${formatPrice(sumPreliminary(props.seats))}`}
          </span>
        </Button>
        <Button loading={props.isReserving} disabled={count === 0} onClick={props.onReserve}>
          Fortsätt
        </Button>
      </div>
      <BottomSheet
        open={isExpanded}
        onClose={() => setIsExpanded(false)}
        title="Din bokning"
        hideTitle
      >
        <BookingSummaryPanel {...props} />
      </BottomSheet>
    </>
  );
}
