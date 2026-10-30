/**
 * Valet i en sektion: sätter ihop de befintliga hookarna (val + markering mot servern + "stol
 * togs") med notiser och bygger sammanfattningsraderna. "Max 5 stolar" stoppas här innan
 * markeringen går till servern. En vald stol som pollingen visar som upptagen tas ur valet.
 */
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  buildSeatLookups,
  useSeatMarkToggle,
  useSeatTakenNotifications,
} from '../../hooks/use-seat-marking.js';
import type { SeatGeometry, SeatStatus, SeatStatusEntry } from '../../lib/api-client.js';
import { MAX_SEATS_PER_RESERVATION } from '../booking/BookingSummaryPanel.js';
import type { SummarySeat } from '../booking/SelectedSeatList.js';

function seatLabel(seat: SeatGeometry | undefined): string {
  return seat === undefined ? 'En stol' : `Rad ${seat.row} plats ${seat.number}`;
}

function buildSummarySeats(
  selected: ReadonlySet<string>,
  seatByVenueSeatId: ReadonlyMap<string, SeatGeometry>,
  priceByVenueSeatId: ReadonlyMap<string, number>,
  sectionName: string,
): SummarySeat[] {
  return [...selected].flatMap((venueSeatId): SummarySeat[] => {
    const seat = seatByVenueSeatId.get(venueSeatId);
    const priceCents = priceByVenueSeatId.get(venueSeatId);
    return seat === undefined || priceCents === undefined
      ? []
      : [{ key: seat.id, row: seat.row, number: seat.number, sectionName, priceCents }];
  });
}

export interface SectionSelection {
  readonly statusByVenueSeatId: ReadonlyMap<string, SeatStatus>;
  readonly priceByVenueSeatId: ReadonlyMap<string, number>;
  readonly selected: ReadonlySet<string>;
  readonly toggle: (venueSeatId: string) => void;
  readonly summarySeats: readonly SummarySeat[];
  readonly seatIds: readonly string[];
}

function useTakenSeatHandling(args: {
  queueToken: string | undefined;
  selected: ReadonlySet<string>;
  deselectSeat: (venueSeatId: string) => void;
  statusByVenueSeatId: ReadonlyMap<string, SeatStatus>;
  seatIdByVenueSeatId: ReadonlyMap<string, string>;
  seatByVenueSeatId: ReadonlyMap<string, SeatGeometry>;
}): void {
  const { queueToken, selected, deselectSeat, statusByVenueSeatId, seatIdByVenueSeatId } =
    args;

  function handleTaken(venueSeatId: string): void {
    if (selected.has(venueSeatId)) {
      deselectSeat(venueSeatId);
      toast.warning(
        `${seatLabel(args.seatByVenueSeatId.get(venueSeatId))} togs av någon annan`,
      );
    }
  }
  useSeatTakenNotifications(queueToken, seatIdByVenueSeatId, handleTaken);
  useEffect(() => {
    for (const venueSeatId of selected) {
      if (statusByVenueSeatId.get(venueSeatId) !== 'available') {
        handleTaken(venueSeatId);
      }
    }
  });
}

export function useSectionSelection(
  eventId: string,
  queueToken: string | undefined,
  sectionName: string,
  geometry: readonly SeatGeometry[],
  seatStatuses: readonly SeatStatusEntry[],
): SectionSelection {
  const { statusByVenueSeatId, seatIdByVenueSeatId } = buildSeatLookups(seatStatuses);
  const priceByVenueSeatId = useMemo(
    () => new Map(seatStatuses.map((seat) => [seat.venueSeatId, seat.priceCents])),
    [seatStatuses],
  );
  const seatByVenueSeatId = useMemo(
    () => new Map(geometry.map((seat) => [seat.id, seat])),
    [geometry],
  );
  const { selected, handleToggleSeat, deselectSeat } = useSeatMarkToggle(
    eventId,
    queueToken,
    seatIdByVenueSeatId,
    MAX_SEATS_PER_RESERVATION,
  );

  function toggle(venueSeatId: string): void {
    if (!selected.has(venueSeatId) && selected.size >= MAX_SEATS_PER_RESERVATION) {
      toast.info(`Max ${MAX_SEATS_PER_RESERVATION} stolar`);
      return;
    }
    handleToggleSeat(venueSeatId);
  }

  useTakenSeatHandling({
    queueToken,
    selected,
    deselectSeat,
    statusByVenueSeatId,
    seatIdByVenueSeatId,
    seatByVenueSeatId,
  });

  const summarySeats = buildSummarySeats(
    selected,
    seatByVenueSeatId,
    priceByVenueSeatId,
    sectionName,
  );
  const seatIds = [...selected].flatMap((id) => seatIdByVenueSeatId.get(id) ?? []);
  return { statusByVenueSeatId, priceByVenueSeatId, selected, toggle, summarySeats, seatIds };
}
