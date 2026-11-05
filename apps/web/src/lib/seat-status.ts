/**
 * Sätter ihop stolsstatusen från API:ets två delar (`?view=catalog` och `?view=compact`, se
 * services/booking-api/src/services/seat-status-views.ts) till samma lista som komponenterna alltid fått.
 *
 * Katalogen (id och pris, fast under en försäljning) hämtas en gång. Statusen pollas varannan sekund och är
 * bara ett tecken per stol i katalogens ordning. Matchningen sker på position, så en katalog som inte hör
 * till statusen får aldrig användas: då kunde en annan stols id hamna på en plats och fel stol reserveras.
 * Därför kastas ett fel hellre än att något gissas, och TanStack Query försöker igen.
 */
import { request } from './http.js';

export type SeatStatus = 'available' | 'held' | 'sold';

export interface SeatStatusEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly status: SeatStatus;
  readonly priceCents: number;
  /** ISO-tid då en aktiv reservation på stolen går ut; `null` för lediga, sålda och stolar i betalning. */
  readonly heldUntil: string | null;
}

export interface SeatCatalogEntry {
  readonly seatId: string;
  readonly venueSeatId: string;
  readonly priceCents: number;
}

export interface SeatCatalog {
  readonly version: string;
  readonly seats: readonly SeatCatalogEntry[];
}

export interface CompactSeatStatus {
  readonly version: string;
  /** Ett tecken per stol i katalogens ordning: `a` ledig, `h` hållen, `s` såld. */
  readonly statuses: string;
  readonly heldUntil: readonly { readonly index: number; readonly until: string }[];
}

export class SeatCatalogMismatchError extends Error {
  constructor(reason: string) {
    super(`Seat catalog does not match the seat status: ${reason}`);
    this.name = 'SeatCatalogMismatchError';
  }
}

const STATUS_BY_CHAR: Readonly<Record<string, SeatStatus>> = {
  a: 'available',
  h: 'held',
  s: 'sold',
};

export function mergeSeatStatus(
  catalog: SeatCatalog,
  compact: CompactSeatStatus,
): SeatStatusEntry[] {
  if (catalog.version !== compact.version) {
    throw new SeatCatalogMismatchError('different versions');
  }
  if (catalog.seats.length !== compact.statuses.length) {
    throw new SeatCatalogMismatchError('different number of seats');
  }
  const heldUntilByIndex = new Map(compact.heldUntil.map((held) => [held.index, held.until]));
  return catalog.seats.map((seat, index) => {
    const status = STATUS_BY_CHAR[compact.statuses.charAt(index)];
    if (status === undefined) {
      throw new SeatCatalogMismatchError(`unknown status at position ${String(index)}`);
    }
    return {
      seatId: seat.seatId,
      venueSeatId: seat.venueSeatId,
      priceCents: seat.priceCents,
      status,
      heldUntil: status === 'held' ? (heldUntilByIndex.get(index) ?? null) : null,
    };
  });
}

function seatStatusPath(eventId: string, sectionId: string): string {
  return `/events/${eventId}/sections/${sectionId}/seats/status`;
}

/** Stolarnas id och pris, fasta under en försäljning. Webbläsaren får behålla den (API:t säger 5 min). */
/**
 * Stolarnas id och pris, fasta under en försäljning. Med `version` (den kompakta statusens) bygger API:t
 * katalogen för just den versionen, och adressen blir unik per version, så ingen cache kan ge en annan.
 */
export function getSectionSeatCatalog(
  eventId: string,
  sectionId: string,
  version?: string,
): Promise<unknown> {
  const versionParam = version === undefined ? '' : `&version=${encodeURIComponent(version)}`;
  return request(`${seatStatusPath(eventId, sectionId)}?view=catalog${versionParam}`);
}

export function getSectionSeatStatusCompact(
  eventId: string,
  sectionId: string,
): Promise<unknown> {
  // `no-store`: Cloudflares "Browser Cache TTL" kan annars höja `max-age=1` till timmar, och då visar
  // pollingen (var 2:a sekund) en gammal karta ur webbläsarens cache.
  return request(`${seatStatusPath(eventId, sectionId)}?view=compact`, { cache: 'no-store' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCatalogEntry(value: unknown): value is SeatCatalogEntry {
  return (
    isRecord(value) &&
    typeof value['seatId'] === 'string' &&
    typeof value['venueSeatId'] === 'string' &&
    typeof value['priceCents'] === 'number'
  );
}

function isSeatCatalog(value: unknown): value is SeatCatalog {
  return (
    isRecord(value) &&
    typeof value['version'] === 'string' &&
    Array.isArray(value['seats']) &&
    value['seats'].every(isCatalogEntry)
  );
}

function isHeldUntil(value: unknown): value is CompactSeatStatus['heldUntil'][number] {
  return (
    isRecord(value) && typeof value['index'] === 'number' && typeof value['until'] === 'string'
  );
}

function isCompactSeatStatus(value: unknown): value is CompactSeatStatus {
  return (
    isRecord(value) &&
    typeof value['version'] === 'string' &&
    typeof value['statuses'] === 'string' &&
    Array.isArray(value['heldUntil']) &&
    value['heldUntil'].every(isHeldUntil)
  );
}

/** Det fulla svaret, som ett API utan `?view=` skickar oavsett vad som efterfrågas. */
function isFullSeatStatus(value: unknown): value is { seats: SeatStatusEntry[] } {
  return isRecord(value) && Array.isArray(value['seats']) && !('version' in value);
}

/** Senast hämtade katalog per sektion (de senaste `MAX_CACHED_CATALOGS`), så att pollingen bara hämtar statusen. */
const seatCatalogs = new Map<string, SeatCatalog>();
const MAX_CACHED_CATALOGS = 5;

function rememberCatalog(key: string, catalog: SeatCatalog): void {
  seatCatalogs.delete(key);
  seatCatalogs.set(key, catalog);
  const oldest = seatCatalogs.keys().next();
  if (seatCatalogs.size > MAX_CACHED_CATALOGS && oldest.done !== true) {
    seatCatalogs.delete(oldest.value);
  }
}

async function readCompact(eventId: string, sectionId: string): Promise<CompactOrFull> {
  const response = await getSectionSeatStatusCompact(eventId, sectionId);
  if (isCompactSeatStatus(response)) {
    return { kind: 'compact', status: response };
  }
  if (isFullSeatStatus(response)) {
    return { kind: 'full', seats: response.seats };
  }
  throw new SeatCatalogMismatchError('unexpected seat status response');
}

type CompactOrFull =
  | { readonly kind: 'compact'; readonly status: CompactSeatStatus }
  | { readonly kind: 'full'; readonly seats: SeatStatusEntry[] };

async function readCatalog(
  eventId: string,
  sectionId: string,
  version: string,
): Promise<SeatCatalog> {
  const response = await getSectionSeatCatalog(eventId, sectionId, version);
  if (!isSeatCatalog(response)) {
    throw new SeatCatalogMismatchError('unexpected catalog response');
  }
  return response;
}

/**
 * Stolsstatusen för en sektion, i samma form som alltid (mergeSeatStatus ovan).
 *
 * Statusen hämtas först och katalogen sedan för exakt dess version, och bara en katalog som stämmer sparas.
 * Är katalogen redan nyare än statusen (stolar ändrades mellan anropen) hämtas statusen om en gång. Svarar
 * ett äldre API (utan `?view=`) med den fulla listan används den direkt, utan någon katalog, så att
 * webbappen och API:t kan rullas ut i vilken ordning som helst.
 */
export async function getSectionSeatStatus(
  eventId: string,
  sectionId: string,
): Promise<{ seats: SeatStatusEntry[] }> {
  const key = `${eventId}/${sectionId}`;
  let compact = await readCompact(eventId, sectionId);
  if (compact.kind === 'full') {
    return { seats: compact.seats };
  }
  const known = seatCatalogs.get(key);
  const catalog =
    known?.version === compact.status.version
      ? known
      : await readCatalog(eventId, sectionId, compact.status.version);
  if (catalog.version !== compact.status.version) {
    compact = await readCompact(eventId, sectionId);
    if (compact.kind === 'full') {
      return { seats: compact.seats };
    }
  }
  if (catalog.version === compact.status.version) {
    rememberCatalog(key, catalog);
  }
  return { seats: mergeSeatStatus(catalog, compact.status) };
}
