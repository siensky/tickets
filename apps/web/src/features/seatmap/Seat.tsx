/**
 * En stol i sektionsvyn (docs/plan.md 7.11 D). Status bärs aldrig av färg ensam: ledig =
 * grön cirkel, upptagen = amber med randning, såld = liten grå cirkel med ×, egen vald =
 * större blå cirkel med ✓ och ring. `memo`: en statusuppdatering renderar bara om de
 * stolar vars props ändrats. Klicket går till `onToggle`, som SectionView vaktar mot ej valbara stolar.
 */
import { memo, type JSX } from 'react';
import { formatPrice } from '../../lib/format.js';
import type { SeatGeometry, SeatStatus } from '../../lib/api-client.js';

export type SeatVisualState = SeatStatus | 'selected';

const STATE_LABEL: Record<SeatVisualState, string> = {
  available: 'ledig',
  held: 'upptagen',
  sold: 'såld',
  selected: 'vald av dig',
};

export function seatAriaLabel(
  seat: Pick<SeatGeometry, 'row' | 'number'>,
  priceCents: number | undefined,
  state: SeatVisualState,
): string {
  const price = priceCents === undefined ? '' : `${formatPrice(priceCents)}, `;
  return `Rad ${seat.row}, plats ${seat.number}, ${price}${STATE_LABEL[state]}`;
}

export const SEAT_HATCH_ID = 'seat-hatch';

/** Mönstret som amber-stolarna fylls med; renderas en gång per karta. */
export function SeatPatterns(): JSX.Element {
  return (
    <defs>
      <pattern id={SEAT_HATCH_ID} width="0.2" height="0.2" patternUnits="userSpaceOnUse">
        <rect width="0.2" height="0.2" className="fill-warning" />
        <path
          d="M-0.05,0.25 L0.25,-0.05"
          className="stroke-warning-content"
          strokeWidth="0.05"
        />
      </pattern>
    </defs>
  );
}

type ShapeProps = { x: number; y: number };

function SelectedShape({ x, y }: ShapeProps): JSX.Element {
  return (
    <>
      <circle cx={x} cy={y} r={0.46} className="fill-none stroke-accent" strokeWidth={0.06} />
      <circle cx={x} cy={y} r={0.4} className="fill-accent" />
      <path
        d={`M${x - 0.18},${y} L${x - 0.04},${y + 0.14} L${x + 0.2},${y - 0.14}`}
        className="fill-none stroke-accent-content"
        strokeWidth={0.08}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

function SoldShape({ x, y }: ShapeProps): JSX.Element {
  return (
    <>
      <circle
        cx={x}
        cy={y}
        r={0.26}
        className="fill-base-300 stroke-muted"
        strokeWidth={0.04}
      />
      <path
        d={`M${x - 0.11},${y - 0.11} L${x + 0.11},${y + 0.11} M${x + 0.11},${y - 0.11} L${x - 0.11},${y + 0.11}`}
        className="stroke-muted"
        strokeWidth={0.05}
        strokeLinecap="round"
      />
    </>
  );
}

export function SeatShape({
  state,
  x,
  y,
}: ShapeProps & { state: SeatVisualState }): JSX.Element {
  switch (state) {
    case 'selected':
      return <SelectedShape x={x} y={y} />;
    case 'sold':
      return <SoldShape x={x} y={y} />;
    case 'held':
      return (
        <circle
          cx={x}
          cy={y}
          r={0.35}
          fill={`url(#${SEAT_HATCH_ID})`}
          className="stroke-warning"
          strokeWidth={0.04}
        />
      );
    case 'available':
      return <circle cx={x} cy={y} r={0.35} className="fill-success" />;
  }
}

export interface SeatProps {
  readonly seat: SeatGeometry;
  readonly state: SeatVisualState;
  readonly priceCents: number | undefined;
  readonly tabIndex: 0 | -1;
  readonly onToggle: (venueSeatId: string) => void;
}

function SeatBase({ seat, state, priceCents, tabIndex, onToggle }: SeatProps): JSX.Element {
  const isUnavailable = state === 'sold' || state === 'held';
  return (
    <g
      role="button"
      tabIndex={tabIndex}
      aria-pressed={state === 'selected'}
      aria-disabled={isUnavailable || undefined}
      aria-label={seatAriaLabel(seat, priceCents, state)}
      data-seat-id={seat.id}
      onClick={() => onToggle(seat.id)}
      className={isUnavailable ? 'cursor-not-allowed' : 'cursor-pointer'}
    >
      <SeatShape state={state} x={seat.x} y={seat.y} />
    </g>
  );
}

export const Seat = memo(SeatBase);
