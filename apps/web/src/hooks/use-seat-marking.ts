/**
 * Local seat selection + server-side seat marking + "din stol togs"
 * (docs/plan.md "Stolsstatus: ... blå egen markering", "Realtid").
 * Selection is local React state; marking is a fire-and-forget
 * best-effort call to services/seat-mark-service.ts so another holder
 * can be told when a seat they'd marked gets taken first.
 */
import { useState } from 'react';
import {
  markSeat as markSeatOnServer,
  unmarkSeat as unmarkSeatOnServer,
  type SeatStatus,
  type SeatStatusEntry,
} from '../lib/api-client.js';
import { useQueueSocket } from './use-queue-socket.js';

export function buildSeatLookups(seatStatuses: readonly SeatStatusEntry[]): {
  statusByVenueSeatId: Map<string, SeatStatus>;
  seatIdByVenueSeatId: Map<string, string>;
} {
  return {
    statusByVenueSeatId: new Map(seatStatuses.map((seat) => [seat.venueSeatId, seat.status])),
    seatIdByVenueSeatId: new Map(seatStatuses.map((seat) => [seat.venueSeatId, seat.seatId])),
  };
}

function useSeatSelection(maxSeats: number): {
  selected: ReadonlySet<string>;
  toggleSeat: (venueSeatId: string) => void;
  deselectSeat: (venueSeatId: string) => void;
} {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  function toggleSeat(venueSeatId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(venueSeatId)) {
        next.delete(venueSeatId);
      } else if (next.size < maxSeats) {
        next.add(venueSeatId);
      }
      return next;
    });
  }

  function deselectSeat(venueSeatId: string): void {
    setSelected((current) => {
      if (!current.has(venueSeatId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(venueSeatId);
      return next;
    });
  }

  return { selected, toggleSeat, deselectSeat };
}

function markOnServer(eventId: string, seatId: string, queueToken: string): void {
  markSeatOnServer(eventId, seatId, queueToken).catch(() => undefined);
}

function unmarkOnServer(eventId: string, seatId: string, queueToken: string): void {
  unmarkSeatOnServer(eventId, seatId, queueToken).catch(() => undefined);
}

/** Listens for "din stol togs" and deselects the affected seat. */
export function useSeatTakenNotifications(
  queueToken: string | undefined,
  seatIdByVenueSeatId: ReadonlyMap<string, string>,
  onSeatTaken: (venueSeatId: string) => void,
): string | undefined {
  const [takenNotice, setTakenNotice] = useState<string | undefined>();

  useQueueSocket(queueToken, (payload) => {
    if (typeof payload !== 'object' || payload === null) {
      return;
    }
    const { type, seatId } = payload as { type?: unknown; seatId?: unknown };
    if (type !== 'seat_taken' || typeof seatId !== 'string') {
      return;
    }
    for (const [venueSeatId, mappedSeatId] of seatIdByVenueSeatId) {
      if (mappedSeatId === seatId) {
        onSeatTaken(venueSeatId);
        setTakenNotice('En av dina valda stolar blev precis tagen av någon annan.');
        return;
      }
    }
  });

  return takenNotice;
}

export function useSeatMarkToggle(
  eventId: string,
  queueToken: string | undefined,
  seatIdByVenueSeatId: ReadonlyMap<string, string>,
  maxSeats: number,
): {
  selected: ReadonlySet<string>;
  handleToggleSeat: (venueSeatId: string) => void;
  deselectSeat: (venueSeatId: string) => void;
} {
  const { selected, toggleSeat, deselectSeat } = useSeatSelection(maxSeats);

  function handleToggleSeat(venueSeatId: string): void {
    const seatId = seatIdByVenueSeatId.get(venueSeatId);
    const wasSelected = selected.has(venueSeatId);
    toggleSeat(venueSeatId);
    if (seatId === undefined || queueToken === undefined) {
      return;
    }
    if (wasSelected) {
      unmarkOnServer(eventId, seatId, queueToken);
    } else {
      markOnServer(eventId, seatId, queueToken);
    }
  }

  return { selected, handleToggleSeat, deselectSeat };
}
