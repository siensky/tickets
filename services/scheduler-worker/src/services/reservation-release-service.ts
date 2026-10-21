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
  expireDueReservations,
  releaseSeatsForReservations,
} from '../repositories/reservation-release-repository.js';

async function releaseExpiredReservationsForPool(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const expiredIds = await expireDueReservations(client);
    await releaseSeatsForReservations(client, expiredIds);
    return expiredIds.length;
  });
}

export function startReservationReleaseJob(
  shardPools: ShardPools,
  logger: Logger,
  intervalMs = 5000,
): NodeJS.Timeout {
  return setInterval(() => {
    for (const pool of shardPools.pools) {
      releaseExpiredReservationsForPool(pool).catch((error: unknown) => {
        logger.warn({ error }, 'reservation release job failed, will retry next tick');
      });
    }
  }, intervalMs);
}
