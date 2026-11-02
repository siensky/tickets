/**
 * Val av event (från `GET /events`) och grind (fast lista, `config.ts`) innan kameran startar
 * (docs/plan.md 7.8). Båda valen krävs; ingen manuell inmatning av biljetter.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type JSX, type ReactNode } from 'react';
import { GATES, type Gate } from '../../config.js';
import { listEvents, type ScanEvent } from '../../lib/api-client.js';
import { formatEventDate } from '../../lib/format.js';

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function EventsError({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <p>Kunde inte hämta eventen.</p>
      <button type="button" className="btn btn-outline btn-neutral min-h-11" onClick={onRetry}>
        Försök igen
      </button>
    </div>
  );
}

function EventSelect({
  events,
  isPending,
  value,
  onChange,
}: {
  events: readonly ScanEvent[] | undefined;
  isPending: boolean;
  value: string;
  onChange: (eventId: string) => void;
}): JSX.Element {
  return (
    <Field label="Event">
      <select
        className="select select-bordered min-h-12 w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={isPending}
      >
        <option value="">{isPending ? 'Hämtar event…' : 'Välj event'}</option>
        {events?.map((event) => (
          <option key={event.id} value={event.id}>
            {event.title} · {formatEventDate(event.startsAt)} · {event.venueName}
          </option>
        ))}
      </select>
    </Field>
  );
}

function GateSelect({
  value,
  onChange,
}: {
  value: Gate | '';
  onChange: (gate: Gate | '') => void;
}): JSX.Element {
  return (
    <Field label="Grind">
      <select
        className="select select-bordered min-h-12 w-full"
        value={value}
        onChange={(event) =>
          onChange(GATES.find((entry) => entry === event.target.value) ?? '')
        }
      >
        <option value="">Välj grind</option>
        {GATES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function SetupScreen({
  logoutButton,
  onStart,
}: {
  logoutButton: ReactNode;
  onStart: (event: ScanEvent, gate: Gate) => void;
}): JSX.Element {
  const eventsQuery = useQuery({ queryKey: ['events'], queryFn: listEvents });
  const [eventId, setEventId] = useState('');
  const [gate, setGate] = useState<Gate | ''>('');
  const selected = eventsQuery.data?.find((event) => event.id === eventId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <img
        src="/brand/tikknet-logo.svg"
        alt="tikknet"
        width={109}
        height={28}
        className="h-7 w-auto self-start"
      />
      <h1>Välj event och grind</h1>
      {eventsQuery.isError ? (
        <EventsError onRetry={() => void eventsQuery.refetch()} />
      ) : (
        <EventSelect
          events={eventsQuery.data}
          isPending={eventsQuery.isPending}
          value={eventId}
          onChange={setEventId}
        />
      )}
      <GateSelect value={gate} onChange={setGate} />
      <button
        type="button"
        className="btn btn-primary min-h-12"
        disabled={selected === undefined || gate === ''}
        onClick={() => selected !== undefined && gate !== '' && onStart(selected, gate)}
      >
        Starta skanning
      </button>
      {logoutButton}
    </main>
  );
}
