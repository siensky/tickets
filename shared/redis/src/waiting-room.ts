/**
 * Väntrummets ZSET (docs/plan.md "Väntrum"): ankomsttid som score ger
 * FIFO-ordning, `ZRANK` ger platsen i kön. Insläpp är en separat,
 * tidsbegränsad markering (`admitted:<event>:<token>`) — token är
 * stateless och bär bara ett HÅRT slut (`exp`, shared/auth: försäljningens
 * slut plus bokningsfönstret), medan den här nyckelns TTL är INAKTIVITETS-
 * taket (10 min, docs/plan.md), förnyat vid aktivitet — men aldrig längre
 * än bokningsfönstret som startar vid insläpp: nyckelns värde är insläppets
 * slutdatum (ms sedan epoch) och TTL:en klipps alltid mot det.
 *
 * Tål en Redis-omstart (docs/plan.md "Redis — användningsområden"): kön
 * byggs om genom att klienter joinar igen, inget går förlorat som inte
 * redan skyddas av tokenens egen `exp`.
 */
import type { Redis } from 'ioredis';
import {
  admittedIndexKey,
  admittedKey,
  waitingRoomActiveEventsKey,
  waitingRoomKey,
} from './keys.js';

/** Insläppets slutdatum sparas som värde; allt under detta är ett äldre `'1'` från före bokningsfönstret. */
const MIN_PLAUSIBLE_DEADLINE_MS = 1_000_000_000_000;

function parseAdmissionDeadline(rawValue: string): number | null {
  const deadlineMs = Number(rawValue);
  return Number.isFinite(deadlineMs) && deadlineMs >= MIN_PLAUSIBLE_DEADLINE_MS
    ? deadlineMs
    : null;
}

/** Nyckelns TTL vid insläpp: inaktivitetstaket, men aldrig längre än bokningsfönstret. */
function admittedTtlSeconds(
  inactivityTtlSeconds: number,
  bookingWindowSeconds: number,
): number {
  return Math.min(inactivityTtlSeconds, bookingWindowSeconds);
}

export async function joinWaitingRoom(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
): Promise<void> {
  await redis.zadd(waitingRoomKey(eventId), Date.now(), queueTokenId);
  await redis.sadd(waitingRoomActiveEventsKey(), eventId);
}

/**
 * Direktinsläpp (docs/plan.md "Väntrum", beslutat efter Fas 7 steg 7): är det tomt i kön och
 * färre än `directAdmitLimit` är insläppta just nu för eventet släpps den som joinar in direkt;
 * annars ställs hen i kön. Kön är alltså kvar som skydd när belastningen är hög, men en enstaka
 * köpare behöver inte vänta. Kontrollen och skrivningen sker atomärt i ett Lua-skript, så att en
 * våg av samtidiga joins inte kan slinka förbi gränsen. Kön måste vara tom för att behålla FIFO:
 * så länge någon väntar går alla nya in bakom hen.
 */
const JOIN_OR_ADMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
local waiting = redis.call('ZCARD', KEYS[1])
local active = redis.call('ZCARD', KEYS[2])
if waiting == 0 and active < tonumber(ARGV[3]) then
  redis.call('SET', KEYS[3], ARGV[6], 'EX', ARGV[4])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[2]) + tonumber(ARGV[4]) * 1000, ARGV[1])
  return 1
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('SADD', KEYS[4], ARGV[5])
return 0
`;

export async function joinOrAdmitWaitingRoom(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
  directAdmitLimit: number,
  inactivityTtlSeconds: number,
  bookingWindowSeconds: number,
): Promise<'admitted' | 'waiting'> {
  const now = Date.now();
  const raw: unknown = await redis.eval(
    JOIN_OR_ADMIT_SCRIPT,
    4,
    waitingRoomKey(eventId),
    admittedIndexKey(eventId),
    admittedKey(eventId, queueTokenId),
    waitingRoomActiveEventsKey(),
    queueTokenId,
    now,
    directAdmitLimit,
    admittedTtlSeconds(inactivityTtlSeconds, bookingWindowSeconds),
    eventId,
    now + bookingWindowSeconds * 1000,
  );
  if (raw !== 0 && raw !== 1) {
    throw new TypeError(`join-or-admit script returned ${String(raw)}`);
  }
  return raw === 1 ? 'admitted' : 'waiting';
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

/**
 * Förnyar inaktivitetsfönstret (docs/plan.md: "10 min inaktivitet") — anropas vid varje autentiserad
 * aktivitet från en insläppt klient. Förnyelsen klipps mot insläppets slutdatum (nyckelns värde), så
 * bokningsfönstret aldrig kan förlängas genom att hålla sidan öppen. Läs-och-förnya är inte atomärt,
 * men slutdatumet ändras aldrig, så en förlorad kapplöpning kan som mest förnya en nyss utgången nyckel
 * (en no-op) — aldrig förlänga den förbi slutdatumet.
 */
export async function touchAdmittedActivity(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
  inactivityTtlSeconds: number,
): Promise<void> {
  const key = admittedKey(eventId, queueTokenId);
  const rawDeadline = await redis.get(key);
  if (rawDeadline === null) {
    return;
  }
  const deadlineMs = parseAdmissionDeadline(rawDeadline);
  const ttlSeconds =
    deadlineMs === null
      ? inactivityTtlSeconds
      : Math.min(inactivityTtlSeconds, Math.floor((deadlineMs - Date.now()) / 1000));
  if (ttlSeconds <= 0) {
    // Fönstret är slut inom en sekund: nyckelns egen TTL låter den lämna av sig själv.
    return;
  }
  await redis.expire(key, ttlSeconds);
  // `XX`: förnyar bara poster som redan finns i indexet (scheduler-insläpp läggs dit också).
  await redis.zadd(
    admittedIndexKey(eventId),
    'XX',
    Date.now() + ttlSeconds * 1000,
    queueTokenId,
  );
}

export interface AdmissionBatchResult {
  readonly admittedQueueTokenIds: readonly string[];
  readonly remainingDepth: number;
}

/**
 * Släpper in upp till `batchSize` av de som väntat längst (lägst score).
 * `ZPOPMIN` är redan en atomisk Redis-kommando — ingen Lua behövs för
 * själva poppningen.
 *
 * Ingen åldersgräns i kön (docs/plan.md "Väntrum"): man står kvar så länge
 * det finns en chans till en plats. Kön töms i stället av scheduler-worker
 * när försäljningen stänger eller eventet är slutsålt (`drainWaitingRoom`),
 * och kötokenens `exp` räcker alltid till försäljningens slut plus
 * bokningsfönstret, så en post i kön har aldrig ett utgånget token.
 */
export async function admitNextBatch(
  redis: Redis,
  eventId: string,
  batchSize: number,
  inactivityTtlSeconds: number,
  bookingWindowSeconds: number,
): Promise<AdmissionBatchResult> {
  const key = waitingRoomKey(eventId);
  const popped = await redis.zpopmin(key, batchSize);
  // ZPOPMIN svarar [medlem, score, medlem, score, …]: varannan post är ett kötoken-id.
  const admittedQueueTokenIds = popped.filter((_, index) => index % 2 === 0);

  // Bokningsfönstret räknas från insläppet, inte från JOIN.
  const admittedAt = Date.now();
  const ttlSeconds = admittedTtlSeconds(inactivityTtlSeconds, bookingWindowSeconds);
  const indexExpiry = admittedAt + ttlSeconds * 1000;
  const deadline = String(admittedAt + bookingWindowSeconds * 1000);
  await Promise.all(
    admittedQueueTokenIds.flatMap((queueTokenId) => [
      redis.set(admittedKey(eventId, queueTokenId), deadline, 'EX', ttlSeconds),
      redis.zadd(admittedIndexKey(eventId), indexExpiry, queueTokenId),
    ]),
  );
  const remainingDepth = await redis.zcard(key);
  if (remainingDepth === 0) {
    await redis.srem(waitingRoomActiveEventsKey(), eventId);
  }
  return { admittedQueueTokenIds, remainingDepth };
}

export async function listActiveWaitingRoomEvents(redis: Redis): Promise<string[]> {
  return redis.smembers(waitingRoomActiveEventsKey());
}

/**
 * Tömmer HELA kön för ett event (docs/plan.md: "Stängt
 * försäljningsfönster ... kön töms med besked", och likadant när eventet
 * är slutsålt) — till skillnad från
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
