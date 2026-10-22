/**
 * Kötoken-revokering (docs/plan.md "Väntrum": tokenen är signerad och
 * stateless, så Redis behövs bara för att slå av ETT redan utfärdat
 * token i förtid — inte för att validera det överhuvudtaget).
 */
import type { Redis } from 'ioredis';
import { revokedKey } from './keys.js';

export async function revokeQueueToken(
  redis: Redis,
  queueTokenId: string,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(revokedKey(queueTokenId), '1', 'EX', ttlSeconds);
}

export async function isQueueTokenRevoked(
  redis: Redis,
  queueTokenId: string,
): Promise<boolean> {
  const exists = await redis.exists(revokedKey(queueTokenId));
  return exists === 1;
}
