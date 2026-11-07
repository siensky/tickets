/**
 * Venue section listing + per-section seat geometry/status (docs/plan.md
 * "Realtid"). Geometry (venue_seats, global) rarely changes and is the
 * endpoint meant for a long edge cache; status (seats, sharded by
 * event_id) is cached in Redis for a couple of seconds to survive 2 s
 * client polling without hammering Postgres — a short TTL, not a
 * write-invalidated cache, is deliberate: a few seconds of staleness
 * here is harmless, the reservation transaction is still the only thing
 * that actually prevents overselling.
 *
 * Status and the section summary are cached as the finished response body
 * (a JSON string) and sent as-is, so a cache hit costs no parsing or
 * re-serialisation (docs/loadtest-cpu-plan.md steg 4).
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { NotFoundError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import {
  seatmapStatusKey,
  seatmapSummaryKey,
  seatmapViewKey,
  type RedisClient,
} from '@tickets/redis';
import { getEventById } from '../repositories/events-repository.js';
import {
  aggregateSeatsBySection,
  listSeatStatusesForSection,
} from '../repositories/seats-repository.js';
import {
  getVenueStage,
  listSeatGeometryForSection,
  listSectionsForVenue,
  listSectionsWithLayout,
  sectionBelongsToVenue,
} from '../repositories/venues-repository.js';
import { toSectionSummary, toSectionSummaryEntry } from '../mappers/seatmap-mapper.js';
import { computeSeatAvailability } from './event-availability.js';
import { createSingleFlight } from './read-cache.js';
import { toSeatStatusBody } from './seat-status-views.js';
import type { SeatStatusView, SectionSummary } from '../types/seatmap.js';
import type { VenueSeatGeometryRow, VenueSectionRow } from '../types/venue.js';

export interface SeatmapServiceDeps {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly logger: Logger;
  /** `Cache-Control: max-age` för sektionssammanfattningen; 0 = ingen header (docs/plan.md 8.3). */
  readonly summaryCacheSeconds?: number;
}

/**
 * Hur länge varje vy av stolsstatusen sparas i Redis. Statusen följer klientens 2 s polling. Katalogen ändras
 * inte under en försäljning, men hålls ändå kort: lägger någon till stolar i sektionen syns det inom 10 s.
 */
const SEAT_STATUS_CACHE_TTL_SECONDS: Readonly<Record<SeatStatusView, number>> = {
  full: 2,
  compact: 2,
  catalog: 10,
};

/**
 * När Redis-nyckeln går ut missar alla samtidiga anrop i podden på en gång. Utan det här frågade vart
 * och ett Postgres efter hela sektionen (5 000 rader i lasttestet) och höll var sin anslutning. Nu delar
 * de på en enda läsning. Ingen extra inaktualitet: de får exakt det svar som läses just nu.
 */
const statusLoads = createSingleFlight<string>();
const summaryLoads = createSingleFlight<string>();

export async function listVenueSections(
  deps: SeatmapServiceDeps,
  venueId: string,
): Promise<VenueSectionRow[]> {
  return listSectionsForVenue(getGlobalPool(deps.shardPools), venueId);
}

export async function getSectionGeometry(
  deps: SeatmapServiceDeps,
  venueId: string,
  sectionId: string,
): Promise<VenueSeatGeometryRow[]> {
  const pool = getGlobalPool(deps.shardPools);
  const belongs = await sectionBelongsToVenue(pool, venueId, sectionId);
  if (!belongs) {
    throw new NotFoundError(`Section ${sectionId} not found for venue ${venueId}`, {
      venueId,
      sectionId,
    });
  }
  return listSeatGeometryForSection(pool, sectionId);
}

/**
 * Fails OPEN on a Redis problem (same stance as
 * queue-auth-service.ts's `isRevokedFailOpen`): the cache is a load
 * shield for the 2 s poll, not a safety mechanism — a Redis hiccup
 * must degrade to "ask Postgres every time", never a 500 for every
 * client watching this section.
 */
async function readCachedBody(
  deps: SeatmapServiceDeps,
  key: string,
): Promise<string | undefined> {
  try {
    return (await deps.redis.get(key)) ?? undefined;
  } catch (error) {
    deps.logger.warn(
      { err: error, key },
      'seatmap cache read failed, falling back to Postgres',
    );
    return undefined;
  }
}

async function writeCachedBody(
  deps: SeatmapServiceDeps,
  key: string,
  body: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await deps.redis.set(key, body, 'EX', ttlSeconds);
  } catch (error) {
    deps.logger.warn({ err: error, key }, 'seatmap cache write failed, ignoring');
  }
}

/** Katalogens svar börjar alltid med versionen (toSeatCatalog lägger den först), så det räcker att titta där. */
function isWantedCatalog(body: string, catalogVersion: string | undefined): boolean {
  return catalogVersion === undefined || body.startsWith(`{"version":"${catalogVersion}"`);
}

function seatStatusCacheKey(view: SeatStatusView, eventId: string, sectionId: string): string {
  return view === 'full'
    ? seatmapStatusKey(eventId, sectionId)
    : seatmapViewKey(view, eventId, sectionId);
}

/**
 * Stolsstatus för en sektion som färdigt svar, i den vy klienten bad om (services/seat-status-views.ts).
 *
 * `catalogVersion`: den version klienten fick i den kompakta statusen. Katalogen ligger i Redis längre än
 * statusen, så när en sektions stolar ändras kan Redis ha den gamla katalogen medan statusen redan visar den
 * nya. Står en annan version i den cachade katalogen läses den om från databasen direkt, i stället för att
 * klienten ska få fel version, fråga igen och till slut visa ett fel.
 */
export async function getSectionSeatStatusBody(
  deps: SeatmapServiceDeps,
  eventId: string,
  sectionId: string,
  view: SeatStatusView = 'full',
  catalogVersion?: string,
): Promise<string> {
  const key = seatStatusCacheKey(view, eventId, sectionId);
  const cached = await readCachedBody(deps, key);
  if (cached !== undefined && isWantedCatalog(cached, catalogVersion)) {
    return cached;
  }
  return statusLoads.get(key, async () => {
    const pool = getPoolForEvent(deps.shardPools, eventId);
    const rows = await listSeatStatusesForSection(pool, eventId, sectionId);
    const body = toSeatStatusBody(rows, view);
    await writeCachedBody(deps, key, body, SEAT_STATUS_CACHE_TTL_SECONDS[view]);
    return body;
  });
}

/**
 * Sektionssammanfattningen som färdigt svar. Cachas i Redis lika länge som dess `max-age`
 * (`summaryCacheSeconds`, docs/plan.md 8.3), så att `GROUP BY`-frågan körs en gång per event och
 * period i stället för en gång per besökare. 0 (API-cachen avstängd) = ingen Redis-cache heller.
 * Ett event som inte finns cachas aldrig (404).
 */
export async function getSectionSummaryBody(
  deps: SeatmapServiceDeps,
  eventId: string,
): Promise<string> {
  const ttlSeconds = deps.summaryCacheSeconds ?? 0;
  if (ttlSeconds <= 0) {
    return JSON.stringify(await getSectionSummary(deps, eventId));
  }
  const key = seatmapSummaryKey(eventId);
  const cached = await readCachedBody(deps, key);
  if (cached !== undefined) {
    return cached;
  }
  return summaryLoads.get(key, async () => {
    const body = JSON.stringify(await getSectionSummary(deps, eventId));
    await writeCachedBody(deps, key, body, ttlSeconds);
    return body;
  });
}

/**
 * Arenakartans översikt (docs/plan.md 7.13 E2): sektionernas layout och
 * scen från global-poolen slås ihop med aggregaten från eventets shard.
 * Sektioner utan stolar för just det här eventet utelämnas.
 */
export async function getSectionSummary(
  deps: SeatmapServiceDeps,
  eventId: string,
): Promise<SectionSummary> {
  const pool = getPoolForEvent(deps.shardPools, eventId);
  const event = await getEventById(pool, eventId);
  if (event === undefined) {
    throw new NotFoundError(`Event ${eventId} not found`, { eventId });
  }
  const globalPool = getGlobalPool(deps.shardPools);
  const [sections, stage, aggregates] = await Promise.all([
    listSectionsWithLayout(globalPool, event.venueId),
    getVenueStage(globalPool, event.venueId),
    aggregateSeatsBySection(pool, eventId),
  ]);
  const aggregateBySection = new Map(aggregates.map((row) => [row.sectionId, row]));
  const entries = sections.flatMap((section) => {
    const aggregate = aggregateBySection.get(section.id);
    return aggregate === undefined
      ? []
      : [
          toSectionSummaryEntry(
            section,
            aggregate,
            computeSeatAvailability(aggregate.availableCount, aggregate.totalCount),
          ),
        ];
  });
  return toSectionSummary(stage, entries);
}
