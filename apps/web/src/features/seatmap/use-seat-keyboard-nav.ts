/**
 * Roving tabindex och piltangenter i sektionsvyn (docs/plan.md 7.11 D). En enda stol är
 * tabbar (`activeSeatId`), piltangenterna flyttar fokus: vänster/höger inom raden, upp/ner
 * till närmaste stol i raden ovanför/under, Home/End till radens ändar. Enter och mellanslag
 * växlar stolen via `onToggle`. Lyssnar på SVG-nivå (events bubblar från stolens `<g>`), så
 * att varje stol kan vara `memo`.
 */
import {
  useCallback,
  useMemo,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { SeatGeometry } from '../../lib/api-client.js';

function groupRows(geometry: readonly SeatGeometry[]): SeatGeometry[][] {
  const byY = new Map<number, SeatGeometry[]>();
  for (const seat of geometry) {
    byY.set(seat.y, [...(byY.get(seat.y) ?? []), seat]);
  }
  return [...byY.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, seats]) => seats.sort((a, b) => a.x - b.x));
}

function closestByX(row: readonly SeatGeometry[], x: number): SeatGeometry | undefined {
  return row.reduce<SeatGeometry | undefined>(
    (best, seat) =>
      best === undefined || Math.abs(seat.x - x) < Math.abs(best.x - x) ? seat : best,
    undefined,
  );
}

function findTarget(
  rows: readonly (readonly SeatGeometry[])[],
  current: SeatGeometry,
  key: string,
): SeatGeometry | undefined {
  const rowIndex = rows.findIndex((row) => row.some((seat) => seat.id === current.id));
  const row = rows[rowIndex];
  if (row === undefined) {
    return undefined;
  }
  const index = row.findIndex((seat) => seat.id === current.id);
  switch (key) {
    case 'ArrowLeft':
      return row[index - 1];
    case 'ArrowRight':
      return row[index + 1];
    case 'Home':
      return row[0];
    case 'End':
      return row[row.length - 1];
    case 'ArrowUp':
      return closestByX(rows[rowIndex - 1] ?? [], current.x);
    case 'ArrowDown':
      return closestByX(rows[rowIndex + 1] ?? [], current.x);
    default:
      return undefined;
  }
}

export function useSeatKeyboardNav(
  geometry: readonly SeatGeometry[],
  svgRef: RefObject<SVGSVGElement | null>,
  onToggle: (venueSeatId: string) => void,
): {
  activeSeatId: string | undefined;
  handleKeyDown: (event: KeyboardEvent<SVGSVGElement>) => void;
  handleFocus: (event: FocusEvent<SVGSVGElement>) => void;
} {
  const rows = useMemo(() => groupRows(geometry), [geometry]);
  const [focusedId, setFocusedId] = useState<string | undefined>();
  const activeSeatId = focusedId ?? rows[0]?.[0]?.id;

  const handleFocus = useCallback((event: FocusEvent<SVGSVGElement>) => {
    const id =
      event.target instanceof Element ? event.target.getAttribute('data-seat-id') : null;
    if (id !== null) {
      setFocusedId(id);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      const id =
        event.target instanceof Element ? event.target.getAttribute('data-seat-id') : null;
      const current = geometry.find((seat) => seat.id === id);
      if (current === undefined) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggle(current.id);
        return;
      }
      const target = findTarget(rows, current, event.key);
      if (target !== undefined) {
        event.preventDefault();
        setFocusedId(target.id);
        svgRef.current?.querySelector<SVGElement>(`[data-seat-id="${target.id}"]`)?.focus();
      }
    },
    [geometry, rows, svgRef, onToggle],
  );

  return { activeSeatId, handleKeyDown, handleFocus };
}
