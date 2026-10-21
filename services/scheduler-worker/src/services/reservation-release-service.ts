/**
 * Periodically releases expired reservations on both shards
 * (docs/plan.md "Concurrency-kärnan"). This is the backstop for lazy
 * expiry: booking-api frees a seat the moment someone tries to reserve
 * it again, but a seat nobody asks for again still needs to come back
 * on sale — that's this job.
 */
import { withTransaction, type ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { Pool } from 'pg';
import {
  expireDueReservationsBatch,
  releaseSeatsForReservations,
} from '../repositories/reservation-release-repository.js';

// Caps how much of a pile-up one tick drains, so a single tick can
// never run long enough to starve the next one — docs/plan.md
// "normal-sale" load-tests up to 50 000 reservations; this still lets
// a tick catch up on a burst (500 × 20 = 10 000) without an unbounded
// loop if reservations kept becoming due faster than they're drained.
const MAX_BATCHES_PER_TICK = 20;

async function releaseOneBatch(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const expiredIds = await expireDueReservationsBatch(client);
    await releaseSeatsForReservations(client, expiredIds);
    return expiredIds.length;
  });
}

async function drainExpiredReservationsForPool(pool: Pool): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const released = await releaseOneBatch(pool);
    if (released === 0) {
      return;
    }
  }
}

export interface ReservationReleaseJob {
  /** Stops future ticks and waits for any tick already in flight. */
  stop(): Promise<void>;
}

export function startReservationReleaseJob(
  shardPools: ShardPools,
  logger: Logger,
  intervalMs = 5000,
): ReservationReleaseJob {
  let tickInFlight: Promise<void> | null = null;

  const runTick = async (): Promise<void> => {
    for (const pool of shardPools.pools) {
      try {
        await drainExpiredReservationsForPool(pool);
      } catch (error) {
        logger.warn({ error }, 'reservation release job failed, will retry next tick');
      }
    }
  };

  const timer = setInterval(() => {
    // Overlap guard: a slow tick (a genuine pile-up, or a slow shard)
    // must not run concurrently with the next one — two ticks racing
    // the same batch query would just fight over the same rows.
    if (tickInFlight !== null) {
      return;
    }
    tickInFlight = runTick().finally(() => {
      tickInFlight = null;
    });
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      // Graceful shutdown (docs/plan.md "Zero-downtime"): let an
      // in-flight batch finish instead of yanking the pool out from
      // under it.
      await tickInFlight;
    },
  };
}
