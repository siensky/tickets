/**
 * En sektions stolar med val, bokningspanel och reservation (docs/plan.md 7.11 D–E). Läser
 * geometrin en gång (statisk) och stolsstatus var 2:a sekund. Befintliga hooks sköter val,
 * markering mot servern och "stol togs" (WS); den här komponenten sätter bara ihop dem.
 */
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Skeleton } from '../../components/ui/Skeleton.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import {
  getSectionGeometry,
  getSectionSeatStatus,
  type SeatGeometry,
  type SeatStatusEntry,
} from '../../lib/api-client.js';
import { BookingSummaryPanel } from '../booking/BookingSummaryPanel.js';
import { MobileSummaryBar } from '../booking/MobileSummaryBar.js';
import { useReservationSubmit } from '../booking/use-reservation-submit.js';
import { SeatLegend } from './SeatLegend.js';
import { SectionView } from './SectionView.js';
import { useSectionSelection } from './use-section-selection.js';

const SEAT_STATUS_POLL_MS = 2000;

function SeatSelector({
  eventId,
  eventTitle,
  sectionName,
  geometry,
  seatStatuses,
  queueToken,
}: {
  eventId: string;
  eventTitle: string;
  sectionName: string;
  geometry: readonly SeatGeometry[];
  seatStatuses: readonly SeatStatusEntry[];
  queueToken: string | undefined;
}): JSX.Element {
  const selection = useSectionSelection(
    eventId,
    queueToken,
    sectionName,
    geometry,
    seatStatuses,
  );
  const submit = useReservationSubmit(eventId, queueToken, selection.seatIds);
  const summaryProps = {
    eventTitle,
    seats: selection.summarySeats,
    isReserving: submit.isReserving,
    errorMessage: submit.errorMessage,
    onReserve: submit.reserve,
  };

  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[1fr_360px] lg:pb-0">
      <div className="flex min-w-0 flex-col gap-4">
        <SeatLegend />
        <SectionView
          geometry={geometry}
          statusByVenueSeatId={selection.statusByVenueSeatId}
          priceByVenueSeatId={selection.priceByVenueSeatId}
          selectedVenueSeatIds={selection.selected}
          onToggleSeat={selection.toggle}
        />
      </div>
      <aside className="hidden lg:sticky lg:top-24 lg:block lg:self-start">
        <BookingSummaryPanel {...summaryProps} />
      </aside>
      <MobileSummaryBar {...summaryProps} />
    </div>
  );
}

export function SectionSeats({
  eventId,
  eventTitle,
  venueId,
  sectionId,
  sectionName,
  queueToken,
}: {
  eventId: string;
  eventTitle: string;
  venueId: string;
  sectionId: string;
  sectionName: string;
  queueToken: string | undefined;
}): JSX.Element {
  const geometryQuery = useQuery({
    queryKey: ['section-geometry', venueId, sectionId],
    queryFn: () => getSectionGeometry(venueId, sectionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const statusQuery = useQuery({
    queryKey: ['section-status', eventId, sectionId],
    queryFn: () => getSectionSeatStatus(eventId, sectionId),
    refetchInterval: SEAT_STATUS_POLL_MS,
  });

  if (geometryQuery.isError || statusQuery.isError) {
    return (
      <ErrorState
        message="Kunde inte hämta stolarna för den sektionen."
        onRetry={() => {
          void geometryQuery.refetch();
          void statusQuery.refetch();
        }}
      />
    );
  }
  if (geometryQuery.isPending || statusQuery.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  return (
    <SeatSelector
      eventId={eventId}
      eventTitle={eventTitle}
      sectionName={sectionName}
      geometry={geometryQuery.data.seats}
      seatStatuses={statusQuery.data.seats}
      queueToken={queueToken}
    />
  );
}
