/**
 * Renders one section's seats, positioned by venue geometry and
 * colored by status (docs/plan.md "Stolsstatus: grön ledig · gul
 * reserverad av annan · grå såld · blå egen markering"). "Blå" is
 * purely local selection state here, never sent to or read from the
 * server before "Gå vidare" creates the reservation.
 *
 * Keyed by `venueSeatId` throughout, matching the geometry endpoint —
 * the caller maps back to the event-scoped `seatId` (needed by
 * POST /reservations) using the status entries it already has.
 */
import type { JSX } from 'react';
import type { SeatGeometry, SeatStatus } from '../lib/api-client.js';

const STATUS_COLOR: Record<SeatStatus, string> = {
  available: '#2e7d32',
  held: '#f9a825',
  sold: '#757575',
};
const SELECTED_COLOR = '#1565c0';
const SEAT_RADIUS = 0.35;

export function SeatGrid({
  geometry,
  statusByVenueSeatId,
  selectedVenueSeatIds,
  onToggleSeat,
}: {
  geometry: readonly SeatGeometry[];
  statusByVenueSeatId: ReadonlyMap<string, SeatStatus>;
  selectedVenueSeatIds: ReadonlySet<string>;
  onToggleSeat: (venueSeatId: string) => void;
}): JSX.Element {
  const maxX = Math.max(1, ...geometry.map((seat) => seat.x));
  const maxY = Math.max(1, ...geometry.map((seat) => seat.y));

  return (
    <svg
      viewBox={`0 0 ${maxX + 1} ${maxY + 1}`}
      style={{ width: '100%', maxWidth: 600, height: 'auto' }}
      role="img"
      aria-label="Stolkarta"
    >
      {geometry.map((seat) => (
        <Seat
          key={seat.id}
          seat={seat}
          status={statusByVenueSeatId.get(seat.id) ?? 'available'}
          isSelected={selectedVenueSeatIds.has(seat.id)}
          onToggleSeat={onToggleSeat}
        />
      ))}
    </svg>
  );
}

function Seat({
  seat,
  status,
  isSelected,
  onToggleSeat,
}: {
  seat: SeatGeometry;
  status: SeatStatus;
  isSelected: boolean;
  onToggleSeat: (venueSeatId: string) => void;
}): JSX.Element {
  const isSold = status === 'sold';
  const fill = isSelected ? SELECTED_COLOR : STATUS_COLOR[status];
  return (
    <circle
      cx={seat.x}
      cy={seat.y}
      r={SEAT_RADIUS}
      fill={fill}
      style={{ cursor: isSold ? 'not-allowed' : 'pointer' }}
      onClick={() => {
        if (!isSold) {
          onToggleSeat(seat.id);
        }
      }}
      role="button"
      aria-label={`Rad ${seat.row}, plats ${seat.number}, ${status}`}
    >
      <title>{`Rad ${seat.row}, plats ${seat.number}`}</title>
    </circle>
  );
}
