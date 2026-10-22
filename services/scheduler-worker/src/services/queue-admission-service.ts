/**
 * Insläpp i väntrummet (docs/plan.md "Tjänster": scheduler-worker äger
 * "Insläpp i väntrummet"). Samma mekanism oavsett hur tom kön är — ingen
 * specialväg för "kön är tom, släpp in direkt" (docs/forsvar.md "Gör
 * belastningen förutsägbar"), så varje event som har NÅGON i kön
 * bearbetas på varje tick, oavsett ködjup.
 *
 * Stängt försäljningsfönster (docs/plan.md "Väntrum": "kön töms med
 * besked") hanteras HÄR, inte i booking-apis join/status — det är det
 * här jobbet som äger övergången från "väntar" till "insläppt eller
 * utslängd", och det är billigare att kolla EN gång per tick per event
 * än en gång per statuspolling.
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import {
  admitNextBatch,
  drainWaitingRoom,
  listActiveWaitingRoomEvents,
  publishToChannel,
  wsChannel,
  type RedisClient,
} from '@tickets/redis';
import { getEventSalesWindow } from '../repositories/events-repository.js';
import { getQueueConfig } from '../repositories/queue-config-repository.js';

const DEFAULT_TICK_INTERVAL_MS = 1000;

export interface QueueAdmissionJob {
  stop(): Promise<void>;
}

async function notifyAdmitted(
  redis: RedisClient,
  queueTokenIds: readonly string[],
): Promise<void> {
  await Promise.all(
    queueTokenIds.map((queueTokenId) =>
      publishToChannel(redis, wsChannel(queueTokenId), { type: 'admitted' }),
    ),
  );
}

async function notifySalesClosed(
  redis: RedisClient,
  queueTokenIds: readonly string[],
): Promise<void> {
  await Promise.all(
    queueTokenIds.map((queueTokenId) =>
      publishToChannel(redis, wsChannel(queueTokenId), { type: 'sales_closed' }),
    ),
  );
}

async function drainClosedSales(
  redis: RedisClient,
  eventId: string,
  logger: Logger,
): Promise<void> {
  const drained = await drainWaitingRoom(redis, eventId);
  if (drained.length > 0) {
    logger.info({ eventId, drained: drained.length }, 'sales window closed, queue drained');
    await notifySalesClosed(redis, drained);
  }
}

/** Takten är per MINUT (docs/plan.md "t.ex. 300/min") — proportionell andel av den per tick, aldrig noll. */
export function batchSizeForTick(
  admissionRatePerMinute: number,
  tickIntervalMs: number,
): number {
  return Math.max(1, Math.round((admissionRatePerMinute * tickIntervalMs) / 60_000));
}

async function admitBatchForEvent(
  shardPools: ShardPools,
  redis: RedisClient,
  eventId: string,
  tickIntervalMs: number,
): Promise<readonly string[]> {
  const config = await getQueueConfig(getGlobalPool(shardPools));
  const batchSize = batchSizeForTick(config.admissionRatePerMinute, tickIntervalMs);
  const inactivityTtlSeconds = config.sessionInactivityMinutes * 60;
  const { admittedQueueTokenIds } = await admitNextBatch(
    redis,
    eventId,
    batchSize,
    inactivityTtlSeconds,
  );
  return admittedQueueTokenIds;
}

async function processEvent(
  shardPools: ShardPools,
  redis: RedisClient,
  eventId: string,
  tickIntervalMs: number,
  logger: Logger,
): Promise<void> {
  const pool = getPoolForEvent(shardPools, eventId);
  const salesWindow = await getEventSalesWindow(pool, eventId);
  if (salesWindow.isAfterClose) {
    await drainClosedSales(redis, eventId, logger);
    return;
  }

  const admittedQueueTokenIds = await admitBatchForEvent(
    shardPools,
    redis,
    eventId,
    tickIntervalMs,
  );
  if (admittedQueueTokenIds.length > 0) {
    await notifyAdmitted(redis, admittedQueueTokenIds);
  }
}

export function startQueueAdmissionJob(
  shardPools: ShardPools,
  redis: RedisClient,
  logger: Logger,
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
): QueueAdmissionJob {
  let tickInFlight: Promise<void> | null = null;

  const runTick = async (): Promise<void> => {
    const eventIds = await listActiveWaitingRoomEvents(redis);
    for (const eventId of eventIds) {
      try {
        await processEvent(shardPools, redis, eventId, intervalMs, logger);
      } catch (error) {
        logger.warn(
          { eventId, error },
          'queue admission tick failed for event, will retry next tick',
        );
      }
    }
  };

  const timer = setInterval(() => {
    // Overlap guard: samma princip som reservation-release-service.ts —
    // en långsam tick (ett verkligt högtryck, eller en seg shard) får
    // aldrig köra samtidigt som nästa.
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
      await tickInFlight;
    },
  };
}
