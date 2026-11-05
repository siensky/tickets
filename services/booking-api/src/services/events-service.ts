/**
 * "Välj evenemang" (docs/plan.md "Domän och användarflöde"). Events are
 * sharded by their own id; venues are global on shard-0 — there is no
 * cross-database join, so every read here fetches both sides and merges
 * them in-memory (docs/plan.md "Databas").
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { InternalError, NotFoundError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import { eventsListKey, type RedisClient } from '@tickets/redis';
import { getEventById, listEvents } from '../repositories/events-repository.js';
import { getVenueById, getVenuesByIds } from '../repositories/venues-repository.js';
import { computeAvailability } from './event-availability.js';
import { parseCachedEventSummaries, toEventSummary } from '../mappers/event-mapper.js';
import type { EventRow, EventsFilter, EventSummary } from '../types/event.js';
import type { ReadCache } from './read-cache.js';

export interface EventsServiceDeps {
  readonly shardPools: ShardPools;
  readonly logger: Logger;
  /** `PUBLIC_ASSET_BASE_URL` (cdn): eventbildernas relativa nycklar blir absoluta URL:er mot den. */
  readonly assetBaseUrl: string;
  /**
   * Kort cache för eventlistan i Redis (docs/plan.md 8.3). Listan aggregerar alla stolar per anrop, så en
   * cache skyddar databasen när startsidan belastas. Utan `listCache` (standard lokalt och i CI) cachas inget.
   */
  readonly listCache?: { readonly redis: RedisClient; readonly ttlSeconds: number };
  /**
   * Kort cache per podd för ett enskilt event (services/read-cache.ts). Eventsidan räknar ihop alla
   * eventets stolar per anrop och läses av varje besökare på väg in i kön. Utan den: ingen cache.
   */
  readonly eventCache?: ReadCache<EventSummary>;
}

/**
 * Lists events on BOTH shards, not scoped by a single `event_id` — the
 * documented exception to docs/rules.md §4 (same shape as "mina
 * ordrar via scatter-gather", docs/plan.md "Databas"): a listing
 * endpoint has no narrower shard key by definition.
 *
 * `allSettled`, not `all`: docs/plan.md's own shard-failure demo
 * ("evenemang på shard-0 fortsätter fungera") requires that one shard
 * being down degrades the listing to a partial result, not a 500 for
 * every event on the shard that's still healthy.
 */
export async function listAllEvents(
  deps: EventsServiceDeps,
  filter: EventsFilter = {},
): Promise<EventSummary[]> {
  // Fritextsök cachas inte (obegränsad nyckelmängd); "alla" och en kategori cachas.
  const cache = filter.search === undefined ? deps.listCache : undefined;
  if (cache === undefined || cache.ttlSeconds <= 0) {
    return (await listAllEventsUncached(deps, filter)).events;
  }
  const key = eventsListKey(filter.category);
  const cached = await readCachedList(deps, cache.redis, key);
  if (cached !== undefined) {
    return cached;
  }
  // Single-flight per pod: samtidiga missar delar EN databasfråga i stället för att alla kör den tunga
  // aggregeringen när nyckeln gått ut (stampede).
  const pending = inFlight.get(key) ?? loadAndCache(deps, cache, key, filter);
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

const inFlight = new Map<string, Promise<EventSummary[]>>();

async function loadAndCache(
  deps: EventsServiceDeps,
  cache: { readonly redis: RedisClient; readonly ttlSeconds: number },
  key: string,
  filter: EventsFilter,
): Promise<EventSummary[]> {
  const { events, isComplete } = await listAllEventsUncached(deps, filter);
  // Ett delresultat (en shard nere) cachas aldrig: annars saknas den shardens event i hela TTL:en.
  if (isComplete) {
    await writeCachedList(deps, cache, key, events);
  }
  return events;
}

/** Fails OPEN på Redis-fel, som stolsstatuscachen: cachen är en lastskärm, inte en säkerhetsmekanism. */
async function readCachedList(
  deps: EventsServiceDeps,
  redis: RedisClient,
  key: string,
): Promise<EventSummary[] | undefined> {
  try {
    const raw = await redis.get(key);
    if (raw === null) {
      return undefined;
    }
    return parseCachedEventSummaries(raw);
  } catch (error) {
    deps.logger.warn(
      { error, key },
      'events list cache read failed, falling back to Postgres',
    );
    return undefined;
  }
}

async function writeCachedList(
  deps: EventsServiceDeps,
  cache: { readonly redis: RedisClient; readonly ttlSeconds: number },
  key: string,
  events: readonly EventSummary[],
): Promise<void> {
  try {
    await cache.redis.set(key, JSON.stringify(events), 'EX', cache.ttlSeconds);
  } catch (error) {
    deps.logger.warn({ error, key }, 'events list cache write failed, ignoring');
  }
}

async function listAllEventsUncached(
  deps: EventsServiceDeps,
  filter: EventsFilter,
): Promise<{ events: EventSummary[]; isComplete: boolean }> {
  const outcomes = await Promise.allSettled(
    deps.shardPools.pools.map((pool) => listEvents(pool, filter)),
  );
  const rows = outcomes.flatMap((outcome, shardIndex) => {
    if (outcome.status === 'rejected') {
      deps.logger.warn(
        { error: outcome.reason, shardIndex },
        'listAllEvents: one shard failed, returning a partial result',
      );
      return [];
    }
    return outcome.value;
  });
  return {
    events: await mergeRowsWithVenues(deps, rows),
    isComplete: outcomes.every((outcome) => outcome.status === 'fulfilled'),
  };
}

async function mergeRowsWithVenues(
  deps: EventsServiceDeps,
  rows: readonly EventRow[],
): Promise<EventSummary[]> {
  const venues = await getVenuesByIds(
    getGlobalPool(deps.shardPools),
    rows.map((row) => row.venueId),
  );
  // A row whose venue can't be found is a data-integrity bug, not
  // something the listing endpoint should 500 over for every OTHER
  // event too — skip it, the same defensive stance as a partial
  // scatter-gather result.
  return rows.flatMap((row) => {
    const venue = venues.get(row.venueId);
    return venue === undefined
      ? []
      : [toEventSummary(row, venue, deps.assetBaseUrl, computeAvailability(row))];
  });
}

export async function getEvent(
  deps: EventsServiceDeps,
  eventId: string,
): Promise<EventSummary> {
  const load = () => loadEvent(deps, eventId);
  return deps.eventCache === undefined ? load() : deps.eventCache.get(eventId, load);
}

async function loadEvent(deps: EventsServiceDeps, eventId: string): Promise<EventSummary> {
  const pool = getPoolForEvent(deps.shardPools, eventId);
  const row = await getEventById(pool, eventId);
  if (row === undefined) {
    throw new NotFoundError(`Event ${eventId} not found`, { eventId });
  }
  const venue = await getVenueById(getGlobalPool(deps.shardPools), row.venueId);
  if (venue === undefined) {
    // Unlike the listing above, this IS the one event the caller asked
    // for — a dangling venue_id here is a bug worth alerting on, not a
    // quiet omission.
    throw new InternalError(`Event ${eventId} references a missing venue`, {
      eventId,
      venueId: row.venueId,
    });
  }
  return toEventSummary(row, venue, deps.assetBaseUrl, computeAvailability(row));
}
