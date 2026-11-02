/**
 * Redis-primitiver för botskyddet (docs/plan.md 8.5): räknare med fast fönster, och en engångsmarkering för
 * proof-of-work-lösningar. Samma INCR + EXPIRE-mönster som rate-limitern (`EXPIRE` bara på första ökningen,
 * annars knuffar en jämn ström fönstret framåt för evigt).
 */
import type { Redis } from 'ioredis';

const COUNT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/** Ökar räknaren med 1 och returnerar det nya värdet. Fönstret startar vid första ökningen. */
export async function incrementCounter(
  redis: Redis,
  key: string,
  windowSeconds: number,
): Promise<number> {
  const raw: unknown = await redis.eval(COUNT_SCRIPT, 1, key, windowSeconds);
  if (typeof raw !== 'number') {
    throw new TypeError(`counter script returned a non-number: ${typeof raw}`);
  }
  return raw;
}

/** Minskar räknaren (frigör en reservation) men aldrig under 0, även om fönstret hunnit gå ut. */
export async function decrementCounter(redis: Redis, key: string): Promise<void> {
  if ((await redis.decr(key)) < 0) {
    await redis.del(key);
  }
}

export async function readCounter(redis: Redis, key: string): Promise<number> {
  const raw = await redis.get(key);
  return raw === null ? 0 : Number(raw);
}

/** `true` om nyckeln inte fanns och nu är satt (första anropet vinner), annars `false`. */
export async function claimOnce(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
}

export async function getWaitingRoomDepth(redis: Redis, queueKey: string): Promise<number> {
  return redis.zcard(queueKey);
}
