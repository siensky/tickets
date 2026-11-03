/**
 * Rensar gamla reservationer (docs/plan.md "Databas": "reservations 30 dagar"). Under ett
 * försäljningsfönster skapas tiotusentals reservationer och de flesta slutar i `expired`, så tabellen
 * växer snabbt. Ordrar och biljetter är självständiga (biljetten vet sin stol, ordern beloppet), så
 * inget går förlorat när reservationen raderas.
 *
 * Körs direkt vid start och sedan varje timme, i stället för ett klockslagsbundet nattjobb: en pod som
 * startas om vid varje deploy hade annars kunnat missa fönstret varje gång, och radering är idempotent.
 * `scheduler-worker` är en enda replik, så två jobb tävlar aldrig om samma rader.
 */
import type { ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { Pool } from 'pg';
import {
  deleteExpiredReservationsBatch,
  RESERVATION_RETENTION_BATCH_SIZE,
} from '../repositories/reservation-retention-repository.js';

export const RESERVATION_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

// Tak per tick så en första stor rensning inte håller igång i all oändlighet; resten tas nästa timme.
const MAX_BATCHES_PER_TICK = 100;

export interface ReservationRetentionJob {
  /** Stoppar kommande ticks och väntar in en tick som redan pågår. */
  stop(): Promise<void>;
}

async function purgePool(pool: Pool, retentionDays: number): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const deleted = await deleteExpiredReservationsBatch(pool, retentionDays);
    total += deleted;
    if (deleted < RESERVATION_RETENTION_BATCH_SIZE) {
      break;
    }
  }
  return total;
}

/** En tick över alla shards. Ett fel på en shard hindrar aldrig de övriga (samma princip som frisläppsjobbet). */
export async function runReservationRetention(
  shardPools: ShardPools,
  logger: Logger,
  retentionDays = RESERVATION_RETENTION_DAYS,
): Promise<number> {
  let total = 0;
  for (const [shardIndex, pool] of shardPools.pools.entries()) {
    try {
      const deleted = await purgePool(pool, retentionDays);
      total += deleted;
      if (deleted > 0) {
        logger.info({ shardIndex, deleted, retentionDays }, 'purged old reservations');
      }
    } catch (error) {
      logger.warn({ shardIndex, error }, 'reservation retention failed, will retry next tick');
    }
  }
  return total;
}

export function startReservationRetentionJob(
  shardPools: ShardPools,
  logger: Logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  retentionDays = RESERVATION_RETENTION_DAYS,
): ReservationRetentionJob {
  let tickInFlight: Promise<void> | null = null;

  const tick = (): void => {
    // Överlappsskydd: en tick som drar ut på tiden får aldrig köra samtidigt som nästa.
    if (tickInFlight !== null) {
      return;
    }
    tickInFlight = runReservationRetention(shardPools, logger, retentionDays)
      .then(() => undefined)
      .finally(() => {
        tickInFlight = null;
      });
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await tickInFlight;
    },
  };
}
