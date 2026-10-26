/**
 * Arenakarta, sektionsvy (docs/plan.md "Domän och användarflöde":
 * "Större arena → sektionsvy, och man klickar på en sektion för att se
 * dess stolar"). Geometry is fetched once (static venue layout);
 * status polls every 2 s (docs/plan.md "Realtid").
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createReservation,
  getEvent,
  getSectionGeometry,
  getSectionSeatStatus,
  listVenueSections,
  type SeatGeometry,
  type SeatStatusEntry,
} from '../lib/api-client.js';
import { useQueueAdmission } from '../hooks/use-queue-admission.js';
import {
  buildSeatLookups,
  useSeatMarkToggle,
  useSeatTakenNotifications,
} from '../hooks/use-seat-marking.js';
import { SeatGrid } from '../components/SeatGrid.js';

const MAX_SEATS_PER_RESERVATION = 5;
const SEAT_STATUS_POLL_MS = 2000;

export function SeatmapPage(): JSX.Element {
  const { eventId: rawEventId } = useParams<{ eventId: string }>();
  const eventId = rawEventId ?? '';
  const [sectionId, setSectionId] = useState<string | undefined>();

  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId),
    enabled: eventId !== '',
  });
  const { token, status } = useQueueAdmission(eventId);

  if (rawEventId === undefined || eventQuery.isPending) {
    return <p>Laddar…</p>;
  }
  if (eventQuery.isError) {
    return <p role="alert">Kunde inte hämta evenemanget.</p>;
  }
  if (status !== undefined && status.status !== 'admitted') {
    return <p role="alert">Du måste vara insläppt från väntrummet för att välja platser.</p>;
  }

  return (
    <section>
      <h1>{eventQuery.data.title} — välj platser</h1>
      {sectionId === undefined ? (
        <SectionList venueId={eventQuery.data.venueId} onSelectSection={setSectionId} />
      ) : (
        <SectionSeats
          eventId={eventId}
          venueId={eventQuery.data.venueId}
          sectionId={sectionId}
          queueToken={token}
          onBack={() => setSectionId(undefined)}
        />
      )}
    </section>
  );
}

function SectionList({
  venueId,
  onSelectSection,
}: {
  venueId: string;
  onSelectSection: (sectionId: string) => void;
}): JSX.Element {
  const sectionsQuery = useQuery({
    queryKey: ['venue-sections', venueId],
    queryFn: () => listVenueSections(venueId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (sectionsQuery.isPending) {
    return <p>Laddar sektioner…</p>;
  }
  if (sectionsQuery.isError) {
    return <p role="alert">Kunde inte hämta sektionerna.</p>;
  }
  return (
    <ul>
      {sectionsQuery.data.sections.map((section) => (
        <li key={section.id}>
          <button type="button" onClick={() => onSelectSection(section.id)}>
            {section.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SectionSeats({
  eventId,
  venueId,
  sectionId,
  queueToken,
  onBack,
}: {
  eventId: string;
  venueId: string;
  sectionId: string;
  queueToken: string | undefined;
  onBack: () => void;
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

  if (geometryQuery.isPending || statusQuery.isPending) {
    return <p>Laddar stolar…</p>;
  }
  if (geometryQuery.isError || statusQuery.isError) {
    return <p role="alert">Kunde inte hämta stolarna för den sektionen.</p>;
  }

  return (
    <div>
      <button type="button" onClick={onBack}>
        ← Tillbaka till sektioner
      </button>
      <SeatSelector
        eventId={eventId}
        geometry={geometryQuery.data.seats}
        seatStatuses={statusQuery.data.seats}
        queueToken={queueToken}
      />
    </div>
  );
}

function resolveSelectedSeatIds(
  selected: ReadonlySet<string>,
  seatIdByVenueSeatId: ReadonlyMap<string, string>,
): string[] {
  return [...selected]
    .map((venueSeatId) => seatIdByVenueSeatId.get(venueSeatId))
    .filter((seatId): seatId is string => seatId !== undefined);
}

function useReservationSubmit(
  eventId: string,
  queueToken: string | undefined,
  selected: ReadonlySet<string>,
  seatIdByVenueSeatId: ReadonlyMap<string, string>,
): { handleContinue: () => void; isError: boolean; errorMessage: string | undefined } {
  const navigate = useNavigate();
  // Generated ONCE per mount, not per click: a retry of the SAME
  // attempt must reuse the same key so the server's idempotency check
  // (docs/plan.md "Idempotens") can actually replay it instead of
  // creating a second reservation attempt that collides on "one active
  // reservation per queue token".
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  const reservationMutation = useMutation({
    mutationFn: (seatIds: readonly string[]) =>
      createReservation(eventId, queueToken ?? '', seatIds, idempotencyKeyRef.current),
    onSuccess: (result) => navigate(`/events/${eventId}/reservations/${result.reservationId}`),
  });

  function handleContinue(): void {
    const seatIds = resolveSelectedSeatIds(selected, seatIdByVenueSeatId);
    if (seatIds.length > 0) {
      reservationMutation.mutate(seatIds);
    }
  }

  return {
    handleContinue,
    isError: reservationMutation.isError,
    errorMessage: reservationMutation.error?.message,
  };
}

function SeatSelector({
  eventId,
  geometry,
  seatStatuses,
  queueToken,
}: {
  eventId: string;
  geometry: readonly SeatGeometry[];
  seatStatuses: readonly SeatStatusEntry[];
  queueToken: string | undefined;
}): JSX.Element {
  const { statusByVenueSeatId, seatIdByVenueSeatId } = buildSeatLookups(seatStatuses);
  const { selected, handleToggleSeat, deselectSeat } = useSeatMarkToggle(
    eventId,
    queueToken,
    seatIdByVenueSeatId,
    MAX_SEATS_PER_RESERVATION,
  );
  const takenNotice = useSeatTakenNotifications(queueToken, seatIdByVenueSeatId, deselectSeat);
  const { handleContinue, isError, errorMessage } = useReservationSubmit(
    eventId,
    queueToken,
    selected,
    seatIdByVenueSeatId,
  );

  return (
    <>
      <SeatGrid
        geometry={geometry}
        statusByVenueSeatId={statusByVenueSeatId}
        selectedVenueSeatIds={selected}
        onToggleSeat={handleToggleSeat}
      />
      {takenNotice !== undefined ? <p role="status">{takenNotice}</p> : null}
      <p>
        {selected.size} av {MAX_SEATS_PER_RESERVATION} stolar valda
      </p>
      <button
        type="button"
        disabled={selected.size === 0 || queueToken === undefined}
        onClick={handleContinue}
      >
        Gå vidare
      </button>
      {isError ? <p role="alert">Kunde inte reservera: {errorMessage}</p> : null}
    </>
  );
}
