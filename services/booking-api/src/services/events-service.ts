/**
 * "Välj evenemang" (docs/plan.md "Domän och användarflöde"). Events are
 * sharded by their own id; venues are global on shard-0 — there is no
 * cross-database join, so every read here fetches both sides and merges
 * them in-memory (docs/plan.md "Databas").
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { InternalError, NotFoundError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import { getEventById, listEvents } from '../repositories/events-repository.js';
import { getVenueById, getVenuesByIds } from '../repositories/venues-repository.js';
import { computeAvailability } from './event-availability.js';
import { toEventSummary } from '../mappers/event-mapper.js';
import type { EventRow, EventsFilter, EventSummary } from '../types/event.js';

export interface EventsServiceDeps {
  readonly shardPools: ShardPools;
  readonly logger: Logger;
  /** `PUBLIC_ASSET_BASE_URL` (cdn): eventbildernas relativa nycklar blir absoluta URL:er mot den. */
  readonly assetBaseUrl: string;
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
  return mergeRowsWithVenues(deps, rows);
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
