/**
 * Sektionsvyn (docs/plan.md 7.11 D steg 2): stolarna som SVG i en pan/zoom/pinch-container.
 * Ett tryck räknas som klick bara om pekaren rört sig mindre än 6 px (annars var det en
 * panorering). Tangentbord: roving tabindex + piltangenter (use-seat-keyboard-nav).
 */
import {
  useCallback,
  useMemo,
  useRef,
  type JSX,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { SeatGeometry, SeatStatus } from '../../lib/api-client.js';
import { Seat, SeatPatterns, type SeatVisualState } from './Seat.js';
import { useSeatKeyboardNav } from './use-seat-keyboard-nav.js';
import { ZoomControls } from './ZoomControls.js';

const DRAG_THRESHOLD_PX = 6;
const ROW_LABEL_OFFSET = 1.1;

function useDragGuard(): {
  onPointerDownCapture: (event: PointerEvent) => void;
  onClickCapture: (event: MouseEvent) => void;
} {
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  return {
    onPointerDownCapture: (event) => {
      start.current = { x: event.clientX, y: event.clientY };
    },
    onClickCapture: (event) => {
      const origin = start.current;
      if (
        origin !== undefined &&
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_THRESHOLD_PX
      ) {
        event.stopPropagation();
      }
    },
  };
}

/**
 * Stabil identitet så att `memo` på Seat håller även när föräldern renderar om. Vaktar också
 * mot att växla stolar som inte går att välja (tangentbordet når även såld/upptagen).
 */
function useGuardedToggle(
  onToggleSeat: (id: string) => void,
  selected: ReadonlySet<string>,
  statusByVenueSeatId: ReadonlyMap<string, SeatStatus>,
): (id: string) => void {
  const toggleRef = useRef<(id: string) => void>(onToggleSeat);
  toggleRef.current = (id) => {
    if (selected.has(id) || statusByVenueSeatId.get(id) === 'available') {
      onToggleSeat(id);
    }
  };
  return useCallback((id: string) => toggleRef.current(id), []);
}

function seatState(
  id: string,
  selected: ReadonlySet<string>,
  statusByVenueSeatId: ReadonlyMap<string, SeatStatus>,
): SeatVisualState {
  return selected.has(id) ? 'selected' : (statusByVenueSeatId.get(id) ?? 'available');
}

function computeViewBox(geometry: readonly SeatGeometry[]): string {
  const xs = geometry.map((seat) => seat.x);
  const ys = geometry.map((seat) => seat.y);
  const minX = Math.min(...xs) - ROW_LABEL_OFFSET - 0.8;
  const minY = Math.min(...ys) - 0.8;
  return `${minX} ${minY} ${Math.max(...xs) + 0.8 - minX} ${Math.max(...ys) + 0.8 - minY}`;
}

function RowLabels({ geometry }: { geometry: readonly SeatGeometry[] }): JSX.Element {
  const minX = Math.min(...geometry.map((seat) => seat.x));
  const rows = new Map(geometry.map((seat) => [seat.row, seat.y]));
  return (
    <g aria-hidden="true" className="fill-muted" fontSize={0.45} textAnchor="middle">
      {[...rows].map(([row, y]) => (
        <text key={row} x={minX - ROW_LABEL_OFFSET} y={y + 0.16}>
          {row}
        </text>
      ))}
    </g>
  );
}

interface SectionViewProps {
  readonly geometry: readonly SeatGeometry[];
  readonly statusByVenueSeatId: ReadonlyMap<string, SeatStatus>;
  readonly priceByVenueSeatId: ReadonlyMap<string, number>;
  readonly selectedVenueSeatIds: ReadonlySet<string>;
  readonly onToggleSeat: (venueSeatId: string) => void;
}

function SeatLayer({
  geometry,
  statusByVenueSeatId,
  priceByVenueSeatId,
  selectedVenueSeatIds,
  activeSeatId,
  onToggle,
}: Omit<SectionViewProps, 'onToggleSeat'> & {
  activeSeatId: string | undefined;
  onToggle: (venueSeatId: string) => void;
}): JSX.Element {
  return (
    <>
      {geometry.map((seat) => (
        <Seat
          key={seat.id}
          seat={seat}
          state={seatState(seat.id, selectedVenueSeatIds, statusByVenueSeatId)}
          priceCents={priceByVenueSeatId.get(seat.id)}
          tabIndex={seat.id === activeSeatId ? 0 : -1}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

export function SectionView(props: SectionViewProps): JSX.Element {
  const { geometry, statusByVenueSeatId, priceByVenueSeatId, selectedVenueSeatIds } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const stableToggle = useGuardedToggle(
    props.onToggleSeat,
    selectedVenueSeatIds,
    statusByVenueSeatId,
  );
  const { activeSeatId, handleKeyDown, handleFocus } = useSeatKeyboardNav(
    geometry,
    svgRef,
    stableToggle,
  );
  const dragGuard = useDragGuard();

  const viewBox = useMemo(() => computeViewBox(geometry), [geometry]);

  return (
    <div className="relative min-h-72 overflow-hidden rounded-box border border-base-300 bg-base-200">
      <TransformWrapper minScale={1} maxScale={5} doubleClick={{ disabled: true }}>
        <ZoomControls />
        <TransformComponent
          wrapperStyle={{ width: '100%', minHeight: '18rem' }}
          contentStyle={{ width: '100%', minHeight: '18rem', alignItems: 'center' }}
        >
          <svg
            ref={svgRef}
            viewBox={viewBox}
            className="h-auto max-h-[70vh] w-full touch-none select-none"
            role="group"
            aria-label="Stolkarta"
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            {...dragGuard}
          >
            <SeatPatterns />
            <RowLabels geometry={geometry} />
            <SeatLayer
              geometry={geometry}
              statusByVenueSeatId={statusByVenueSeatId}
              priceByVenueSeatId={priceByVenueSeatId}
              selectedVenueSeatIds={selectedVenueSeatIds}
              activeSeatId={activeSeatId}
              onToggle={stableToggle}
            />
          </svg>
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}
