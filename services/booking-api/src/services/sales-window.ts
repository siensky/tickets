/**
 * Försäljningsfönstret för väntrummet (docs/plan.md "Väntrum"), med en kort cache per podd.
 *
 * Tiden som avgör om fönstret är öppet är Postgres `now()` (docs/rules.md §4), aldrig poddens klocka:
 * läsningen tar med `now()` från databasen, och för en cachad läsning läggs den tid som gått sedan dess
 * till, mätt med poddens MONOTONA klocka (`performance.now()`). Den mäter bara förfluten tid och påverkas
 * inte av att poddarnas väggklockor går olika, så alla poddar fattar samma beslut vid fönsterkanten.
 */
import type { Pool } from 'pg';
import { getEventSalesWindow } from '../repositories/events-repository.js';
import type { EventSalesWindow, EventSalesWindowSnapshot } from '../types/queue.js';
import type { ReadCache } from './read-cache.js';

export interface TimedSalesWindowSnapshot {
  readonly snapshot: EventSalesWindowSnapshot;
  /** `performance.now()` precis innan raden lästes. */
  readonly readAtMs: number;
}

/** Samma regler som SQL-uttrycken förut: `now() < öppning`, `now() > stängning`, sekunder kvar avrundat uppåt. */
export function toSalesWindow(
  snapshot: EventSalesWindowSnapshot,
  elapsedMs: number,
): EventSalesWindow {
  const dbNowMs = snapshot.dbNow.getTime() + Math.max(0, elapsedMs);
  const openMs = snapshot.salesOpenAt.getTime();
  const closeMs = snapshot.salesCloseAt.getTime();
  return {
    salesOpenAt: snapshot.salesOpenAt,
    salesCloseAt: snapshot.salesCloseAt,
    isBeforeOpen: dbNowMs < openMs,
    isAfterClose: dbNowMs > closeMs,
    secondsUntilClose: Math.max(0, Math.ceil((closeMs - dbNowMs) / 1000)),
  };
}

export async function readSalesWindow(
  pool: Pool,
  eventId: string,
  cache: ReadCache<TimedSalesWindowSnapshot> | undefined,
  now: () => number = () => performance.now(),
): Promise<EventSalesWindow> {
  // Klockan läses FÖRE frågan: Postgres `now()` tas någonstans under den, så den förflutna tiden blir
  // hellre lite för stor än för liten. Fönstret stänger då en aning tidigt, aldrig för sent.
  const load = async (): Promise<TimedSalesWindowSnapshot> => {
    const readAtMs = now();
    return { snapshot: await getEventSalesWindow(pool, eventId), readAtMs };
  };
  const timed = cache === undefined ? await load() : await cache.get(eventId, load);
  return toSalesWindow(timed.snapshot, now() - timed.readAtMs);
}
