/**
 * Markerade stolar per kötoken (docs/plan.md "Realtid": "'Din stol
 * togs' kräver att servern känner till markeringar — de registreras i
 * ett Redis-set per kötoken, annars finns det inget att skicka
 * meddelandet om"). Ren lagringsprimitiv — vilket flöde som faktiskt
 * skriver och läser den hör till seatmap-UI:t (senare fas).
 */
import type { Redis } from 'ioredis';
import { seatMarksKey } from './keys.js';

export async function markSeat(
  redis: Redis,
  queueTokenId: string,
  seatId: string,
  ttlSeconds: number,
): Promise<void> {
  const key = seatMarksKey(queueTokenId);
  await redis.sadd(key, seatId);
  await redis.expire(key, ttlSeconds);
}

export async function unmarkSeat(
  redis: Redis,
  queueTokenId: string,
  seatId: string,
): Promise<void> {
  await redis.srem(seatMarksKey(queueTokenId), seatId);
}

export async function getMarkedSeats(redis: Redis, queueTokenId: string): Promise<string[]> {
  return redis.smembers(seatMarksKey(queueTokenId));
}
