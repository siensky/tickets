/**
 * Väntrummet (docs/plan.md "Väntrum"): utfärdar en signerad, stateless
 * kötoken vid join, och läser status via Redis. Insläpp ur kön görs av
 * scheduler-workers periodiska jobb. Undantaget är direktinsläppet vid join
 * (`joinOrAdmitWaitingRoom`): är kön tom och färre än `queue_direct_admit_limit`
 * är insläppta för eventet släpps joinaren in direkt.
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { SalesClosedError, SalesNotOpenError } from '@tickets/domain';
import {
  getCachedConfigValue,
  getWaitingRoomStatus,
  joinOrAdmitWaitingRoom,
  touchAdmittedActivity,
  type RedisClient,
} from '@tickets/redis';
import { createQueueTokenSecret, issueQueueToken } from '@tickets/auth';
import type { BusinessMetrics } from '@tickets/observability';
import {
  getQueueConfig,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from '../repositories/config-repository.js';
import { getEventSalesWindow } from '../repositories/events-repository.js';
import type {
  EventSalesWindow,
  JoinQueueInput,
  JoinQueueResult,
  QueueConfig,
  QueueStatusResult,
} from '../types/queue.js';

export interface QueueServiceDeps {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly queueTokenSecret: ReturnType<typeof createQueueTokenSecret>;
  readonly businessMetrics: BusinessMetrics;
}

// Cachar varje nyckel var för sig (docs/plan.md "Redis —
// användningsområden": "Config-cache ... 5 s TTL"), inte som en
// sammanslagen JSON-blob — det matchar `config:<key>`-konventionen i
// @tickets/redis och slipper en egen valideringsväg för en
// deserialiserad composite. En kall cache kan köra `getQueueConfig`
// (en billig, tre-rader-fråga) upp till tre gånger parallellt istället
// för en — försumbart var 5:e sekund.
async function getCachedQueueConfig(deps: QueueServiceDeps): Promise<QueueConfig> {
  const pool = getGlobalPool(deps.shardPools);
  const [admissionRate, sessionTotal, sessionInactivity, directAdmitLimit] = await Promise.all(
    [
      getCachedConfigValue(deps.redis, 'queue_admission_rate_per_minute', 5, async () =>
        String((await getQueueConfig(pool)).admissionRatePerMinute),
      ),
      getCachedConfigValue(deps.redis, 'queue_session_total_minutes', 5, async () =>
        String((await getQueueConfig(pool)).sessionTotalMinutes),
      ),
      getCachedConfigValue(deps.redis, 'queue_session_inactivity_minutes', 5, async () =>
        String((await getQueueConfig(pool)).sessionInactivityMinutes),
      ),
      getCachedConfigValue(deps.redis, 'queue_direct_admit_limit', 5, async () =>
        String((await getQueueConfig(pool)).directAdmitLimit),
      ),
    ],
  );

  return {
    admissionRatePerMinute: parsePositiveInteger(
      'queue_admission_rate_per_minute',
      admissionRate,
    ),
    sessionTotalMinutes: parsePositiveInteger('queue_session_total_minutes', sessionTotal),
    sessionInactivityMinutes: parsePositiveInteger(
      'queue_session_inactivity_minutes',
      sessionInactivity,
    ),
    directAdmitLimit: parseNonNegativeInteger('queue_direct_admit_limit', directAdmitLimit),
  };
}

function assertSalesWindowOpen(eventId: string, salesWindow: EventSalesWindow): void {
  if (salesWindow.isBeforeOpen) {
    throw new SalesNotOpenError(eventId, salesWindow.salesOpenAt.toISOString());
  }
  if (salesWindow.isAfterClose) {
    throw new SalesClosedError(eventId);
  }
}

export async function joinQueue(
  deps: QueueServiceDeps,
  input: JoinQueueInput,
): Promise<JoinQueueResult> {
  const pool = getPoolForEvent(deps.shardPools, input.eventId);
  const salesWindow = await getEventSalesWindow(pool, input.eventId);
  assertSalesWindowOpen(input.eventId, salesWindow);

  const config = await getCachedQueueConfig(deps);
  const issued = await issueQueueToken(
    deps.queueTokenSecret,
    input.eventId,
    config.sessionTotalMinutes * 60,
  );
  // Tomt i kön och under gränsen: direkt in (klientens första statusanrop ger `admitted`).
  await joinOrAdmitWaitingRoom(
    deps.redis,
    input.eventId,
    issued.queueTokenId,
    config.directAdmitLimit,
    config.sessionInactivityMinutes * 60,
  );
  // docs/plan.md "Vad som mäts": insläppstakt/konverteringsgrad räknas
  // i Grafana som en kvot mot den här nämnaren.
  deps.businessMetrics.queueJoinsTotal.inc({ event_id: input.eventId });

  return { token: issued.token, eventId: input.eventId };
}

export async function getQueueStatus(
  deps: QueueServiceDeps,
  eventId: string,
  queueTokenId: string,
): Promise<QueueStatusResult> {
  const waitingRoomStatus = await getWaitingRoomStatus(deps.redis, eventId, queueTokenId);
  if (waitingRoomStatus.kind === 'not_found') {
    // Kön kan ha tömts av scheduler-workers drainClosedSales (docs/plan.md
    // "Väntrum": "Stängt försäljningsfönster ... kön töms med besked") —
    // då ska klienten kunna läsa ett tillstånd den förstår här också, inte
    // bara via det fire-and-forget WS-meddelandet (docs/plan.md "Realtid").
    const pool = getPoolForEvent(deps.shardPools, eventId);
    const salesWindow = await getEventSalesWindow(pool, eventId);
    if (salesWindow.isAfterClose) {
      return { status: 'sales_closed' };
    }
    return { status: 'not_found' };
  }
  if (waitingRoomStatus.kind === 'waiting') {
    return {
      status: 'waiting',
      position: waitingRoomStatus.position,
      queueDepth: waitingRoomStatus.queueDepth,
    };
  }

  const config = await getCachedQueueConfig(deps);
  await touchAdmittedActivity(
    deps.redis,
    eventId,
    queueTokenId,
    config.sessionInactivityMinutes * 60,
  );
  return { status: 'admitted' };
}
