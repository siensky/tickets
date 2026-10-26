/**
 * Markerade stolar per kötoken (docs/plan.md "Realtid": "'Din stol
 * togs' kräver att servern känner till markeringar — de registreras i
 * ett Redis-set per kötoken, annars finns det inget att skicka
 * meddelandet om"). Ren lagringsprimitiv — vilket flöde som faktiskt
 * skriver och läser den hör till seatmap-UI:t (Fas 5).
 *
 * `seatMarkHoldersKey` är den omvända indexeringen: UTAN den skulle
 * "din stol togs" bara kunna svara frågan "vilka stolar har DEN HÄR
 * kötokenen markerat", inte "vilka kötoken har markerat DEN HÄR stolen"
 * — och det är den andra frågan som avgör vem som ska notifieras när
 * stolen går till någon annan. Båda seten delar TTL så en glömd
 * unmark aldrig läcker för evigt.
 */
import type { Redis } from 'ioredis';
import { seatMarkHoldersKey, seatMarksKey } from './keys.js';

export async function markSeat(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
  seatId: string,
  ttlSeconds: number,
): Promise<void> {
  const ownKey = seatMarksKey(queueTokenId);
  const holdersKey = seatMarkHoldersKey(eventId, seatId);
  await Promise.all([
    redis.sadd(ownKey, seatId).then(() => redis.expire(ownKey, ttlSeconds)),
    redis.sadd(holdersKey, queueTokenId).then(() => redis.expire(holdersKey, ttlSeconds)),
  ]);
}

export async function unmarkSeat(
  redis: Redis,
  eventId: string,
  queueTokenId: string,
  seatId: string,
): Promise<void> {
  await Promise.all([
    redis.srem(seatMarksKey(queueTokenId), seatId),
    redis.srem(seatMarkHoldersKey(eventId, seatId), queueTokenId),
  ]);
}

export async function getMarkedSeats(redis: Redis, queueTokenId: string): Promise<string[]> {
  return redis.smembers(seatMarksKey(queueTokenId));
}

/** Vilka kötoken har just nu markerat denna stol (docs/plan.md "Din stol togs"). */
export async function getSeatMarkHolders(
  redis: Redis,
  eventId: string,
  seatId: string,
): Promise<string[]> {
  return redis.smembers(seatMarkHoldersKey(eventId, seatId));
}

/**
 * Städar bort markeringen hos ALLA som hade den, sedan "din stol togs"
 * redan skickats till dem (docs/forsvar.md-principen: WS-pushen är bara
 * en optimering, men det kvarvarande Redis-tillståndet ska inte peka på
 * en stol som inte längre går att reservera).
 */
export async function clearSeatMarkHolders(
  redis: Redis,
  eventId: string,
  seatId: string,
  holderQueueTokenIds: readonly string[],
): Promise<void> {
  await Promise.all([
    redis.del(seatMarkHoldersKey(eventId, seatId)),
    ...holderQueueTokenIds.map((queueTokenId) =>
      redis.srem(seatMarksKey(queueTokenId), seatId),
    ),
  ]);
}
