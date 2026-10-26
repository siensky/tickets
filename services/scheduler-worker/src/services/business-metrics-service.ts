/**
 * Periodiskt satta affärsmått (docs/plan.md "Vad som mäts" → "Affär":
 * "Aktiva reservationer ... sålda biljetter" — saknade helt fram till
 * Fas 6, se docs/phase-status.md "Läget efter Fas 4"). Samma
 * `setInterval`-mönster som reservation-release-service.ts, men utan
 * att FÖRÄNDRA någon rad — bara läser och sätter två Gauges.
 *
 * `.reset()` före varje tick: en Gauge som bara fick `.set()` för de
 * event_id COUNT-frågan råkar returnera den här gången hade annars
 * fastnat på sitt SENASTE icke-noll-värde för gott när en kö/reservations-
 * mängd faktiskt går till noll (GROUP BY utesluter grupper utan rader —
 * "noll" syns aldrig som en rad att sätta).
 */
import type { ShardPools } from '@tickets/db';
import type { BusinessMetrics, Logger } from '@tickets/observability';
import {
  countActiveReservations,
  countSoldTickets,
} from '../repositories/business-metrics-repository.js';

const DEFAULT_TICK_INTERVAL_MS = 5000;

export interface BusinessMetricsJob {
  stop(): Promise<void>;
}

async function runTick(
  shardPools: ShardPools,
  metrics: BusinessMetrics,
  logger: Logger,
): Promise<void> {
  const activeReservations: { eventId: string; count: number }[] = [];
  const soldTickets: { eventId: string; count: number }[] = [];
  for (const pool of shardPools.pools) {
    try {
      activeReservations.push(...(await countActiveReservations(pool)));
      soldTickets.push(...(await countSoldTickets(pool)));
    } catch (error) {
      logger.warn(
        { error },
        'business metrics tick failed for one shard, will retry next tick',
      );
    }
  }
  metrics.activeReservations.reset();
  for (const { eventId, count } of activeReservations) {
    metrics.activeReservations.set({ event_id: eventId }, count);
  }
  metrics.soldTickets.reset();
  for (const { eventId, count } of soldTickets) {
    metrics.soldTickets.set({ event_id: eventId }, count);
  }
}

export function startBusinessMetricsJob(
  shardPools: ShardPools,
  metrics: BusinessMetrics,
  logger: Logger,
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
): BusinessMetricsJob {
  let tickInFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    // Overlap guard: samma princip som reservation-release-service.ts.
    if (tickInFlight !== null) {
      return;
    }
    tickInFlight = runTick(shardPools, metrics, logger).finally(() => {
      tickInFlight = null;
    });
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await tickInFlight;
    },
  };
}
