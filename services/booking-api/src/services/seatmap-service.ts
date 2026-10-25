/**
 * Venue section listing + per-section seat geometry/status (docs/plan.md
 * "Realtid"). Geometry (venue_seats, global) rarely changes and is the
 * endpoint meant for a long edge cache; status (seats, sharded by
 * event_id) is cached in Redis for a couple of seconds to survive 2 s
 * client polling without hammering Postgres — a short TTL, not a
 * write-invalidated cache, is deliberate: a few seconds of staleness
 * here is harmless, the reservation transaction is still the only thing
 * that actually prevents overselling.
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { NotFoundError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import { seatmapStatusKey, type RedisClient } from '@tickets/redis';
import { listSeatStatusesForSection } from '../repositories/seats-repository.js';
import {
  listSeatGeometryForSection,
  listSectionsForVenue,
  sectionBelongsToVenue,
} from '../repositories/venues-repository.js';
import { parseCachedSeatStatuses, toSeatStatusEntries } from '../mappers/seatmap-mapper.js';
import type { SeatStatusEntry } from '../types/seatmap.js';
import type { VenueSeatGeometryRow, VenueSectionRow } from '../types/venue.js';

export interface SeatmapServiceDeps {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly logger: Logger;
}

const SEAT_STATUS_CACHE_TTL_SECONDS = 2;

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
async function readCachedSeatStatus(
  deps: SeatmapServiceDeps,
  key: string,
): Promise<SeatStatusEntry[] | undefined> {
  try {
    const cached = await deps.redis.get(key);
    return cached === null ? undefined : parseCachedSeatStatuses(cached);
  } catch (error) {
    deps.logger.warn(
      { error, key },
      'seatmap status cache read failed, falling back to Postgres',
    );
    return undefined;
  }
}

async function writeCachedSeatStatus(
  deps: SeatmapServiceDeps,
  key: string,
  entries: readonly SeatStatusEntry[],
): Promise<void> {
  try {
    await deps.redis.set(key, JSON.stringify(entries), 'EX', SEAT_STATUS_CACHE_TTL_SECONDS);
  } catch (error) {
    deps.logger.warn({ error, key }, 'seatmap status cache write failed, ignoring');
  }
}

export async function getSectionSeatStatus(
  deps: SeatmapServiceDeps,
  eventId: string,
  sectionId: string,
): Promise<SeatStatusEntry[]> {
  const key = seatmapStatusKey(eventId, sectionId);
  const cached = await readCachedSeatStatus(deps, key);
  if (cached !== undefined) {
    return cached;
  }

  const pool = getPoolForEvent(deps.shardPools, eventId);
  const rows = await listSeatStatusesForSection(pool, eventId, sectionId);
  const entries = toSeatStatusEntries(rows);
  await writeCachedSeatStatus(deps, key, entries);
  return entries;
}
