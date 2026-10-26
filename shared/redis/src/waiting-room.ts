/**
 * Väntrummets ZSET (docs/plan.md "Väntrum"): ankomsttid som score ger
 * FIFO-ordning, `ZRANK` ger platsen i kön. Insläpp är en separat,
 * tidsbegränsad markering (`admitted:<event>:<token>`) — token är
 * stateless och bär bara sessionens HÅRDA 15-minuterstak (`exp`,
 * shared/auth), medan den här nyckelns TTL är INAKTIVITETS-taket
 * (10 min, docs/plan.md), förnyat vid aktivitet.
 *
 * Tål en Redis-omstart (docs/plan.md "Redis — användningsområden"): kön
 * byggs om genom att klienter joinar igen, inget går förlorat som inte
 * redan skyddas av tokenens egen `exp`.
 */
import type { Redis } from 'ioredis';
import { admittedKey, waitingRoomActiveEventsKey, waitingRoomKey } from './keys.js';

export async function joinWaitingRoom(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
): Promise<void> {
  await redis.zadd(waitingRoomKey(eventId), Date.now(), queueTokenId);
  await redis.sadd(waitingRoomActiveEventsKey(), eventId);
}

export type WaitingRoomStatus =
  | { readonly kind: 'waiting'; readonly position: number; readonly queueDepth: number }
  | { readonly kind: 'admitted' }
  | { readonly kind: 'not_found' };

export async function getWaitingRoomStatus(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
): Promise<WaitingRoomStatus> {
  const admitted = await redis.exists(admittedKey(eventId, queueTokenId));
  if (admitted === 1) {
    return { kind: 'admitted' };
  }
  const rank = await redis.zrank(waitingRoomKey(eventId), queueTokenId);
  if (rank === null) {
    return { kind: 'not_found' };
  }
  const queueDepth = await redis.zcard(waitingRoomKey(eventId));
  return { kind: 'waiting', position: rank + 1, queueDepth };
}

export async function isAdmitted(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
): Promise<boolean> {
  const exists = await redis.exists(admittedKey(eventId, queueTokenId));
  return exists === 1;
}

/** Förnyar inaktivitetsfönstret (docs/plan.md: "10 min inaktivitet") — anropas vid varje autentiserad aktivitet från en insläppt klient. */
export async function touchAdmittedActivity(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
  inactivityTtlSeconds: number,
): Promise<void> {
  await redis.expire(admittedKey(eventId, queueTokenId), inactivityTtlSeconds);
}

export interface AdmissionBatchResult {
  readonly admittedQueueTokenIds: readonly string[];
  readonly remainingDepth: number;
  readonly prunedExpiredCount: number;
}

/**
 * Släpper in upp till `batchSize` av de som väntat längst (lägst score).
 * `ZPOPMIN` är redan en atomisk Redis-kommando — ingen Lua behövs för
 * själva poppningen.
 *
 * Score = ankomsttid (ms, `Date.now()` i `joinWaitingRoom`) — samma
 * klocka tokenens egen `exp` beräknades från vid JOIN
 * (shared/auth/src/queue-token.ts), så `now() - score` jämfört med
 * `sessionTotalMinutes` återskapar exakt samma gräns utan att tokenen
 * själv behöver avkodas här.
 *
 * Fas 6 (Fas 3-reviewns notering): en poppad post som redan passerat
 * sin sessions-TTL markeras INTE insläppt — annars slösas kvoten på en
 * token ingen längre kan använda. Loopen fortsätter popppa tills
 * `batchSize` LEVANDE poster hittats eller kön är tom, så en djup kö
 * full av redan döda sessioner inte i onödan sänker den faktiska
 * insläppstakten för de som fortfarande är giltiga.
 *
 * Känt avvägning: är HELA den återstående kön död (`queue-storm` långt
 * efter att insläppstakten inte hunnit med) gör detta en engångs-
 * "städning" i en enda tick med många ZPOPMIN-anrop istället för att
 * fördela kostnaden över flera tick — accepterat medvetet, samma princip
 * som NOWAIT-409:orna i reservationstransaktionen (docs/plan.md
 * "Concurrency-kärnan"): korrekthet före finess i ett sällan uppnått
 * värsta fall.
 */
export async function admitNextBatch(
  redis: Redis,
  eventId: string,
  batchSize: number,
  inactivityTtlSeconds: number,
  sessionTotalMinutes: number,
): Promise<AdmissionBatchResult> {
  const key = waitingRoomKey(eventId);
  const sessionTotalMs = sessionTotalMinutes * 60_000;
  const admittedQueueTokenIds: string[] = [];
  let prunedExpiredCount = 0;

  let remaining = batchSize;
  while (remaining > 0) {
    const popped = await redis.zpopmin(key, remaining);
    if (popped.length === 0) {
      break;
    }
    const now = Date.now();
    for (let i = 0; i < popped.length; i += 2) {
      const queueTokenId = popped[i];
      const rawScore = popped[i + 1];
      if (queueTokenId === undefined || rawScore === undefined) {
        continue;
      }
      if (now - Number(rawScore) > sessionTotalMs) {
        prunedExpiredCount += 1;
      } else {
        admittedQueueTokenIds.push(queueTokenId);
      }
    }
    remaining = batchSize - admittedQueueTokenIds.length;
  }

  await Promise.all(
    admittedQueueTokenIds.map((queueTokenId) =>
      redis.set(admittedKey(eventId, queueTokenId), '1', 'EX', inactivityTtlSeconds),
    ),
  );
  const remainingDepth = await redis.zcard(key);
  if (remainingDepth === 0) {
    await redis.srem(waitingRoomActiveEventsKey(), eventId);
  }
  return { admittedQueueTokenIds, remainingDepth, prunedExpiredCount };
}

export async function listActiveWaitingRoomEvents(redis: Redis): Promise<string[]> {
  return redis.smembers(waitingRoomActiveEventsKey());
}

/**
 * Tömmer HELA kön för ett event (docs/plan.md: "Stängt
 * försäljningsfönster ... kön töms med besked") — till skillnad från
 * `admitNextBatch` markeras ingen av dem som insläppta, de ska bara
 * meddelas och erbjudas väntelistan.
 */
export async function drainWaitingRoom(redis: Redis, eventId: string): Promise<string[]> {
  const key = waitingRoomKey(eventId);
  const members = await redis.zrange(key, '0', '-1');
  if (members.length > 0) {
    await redis.del(key);
  }
  await redis.srem(waitingRoomActiveEventsKey(), eventId);
  return members;
}
