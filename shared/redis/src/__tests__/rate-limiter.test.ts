import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { checkRateLimit } from '../rate-limiter.js';

// Endast `eval` anropas av checkRateLimit — ett fejkat objekt begränsat
// till det, castat upp till Redis (samma mönster som shared/db:s egna
// testfejker av PoolClient, se transaction.test.ts).
function createFakeRedis(evalResult: unknown): {
  redis: Redis;
  eval: ReturnType<typeof vi.fn>;
} {
  const evalFn = vi.fn().mockResolvedValue(evalResult);
  const redis = { eval: evalFn } as unknown as Redis;
  return { redis, eval: evalFn };
}

describe('checkRateLimit', () => {
  it('allows the request when the count is at or below the limit', async () => {
    const { redis } = createFakeRedis(50);
    const result = await checkRateLimit(redis, '1.2.3.4', 50);
    expect(result).toEqual({ allowed: true, count: 50 });
  });

  it('blocks the request once the count exceeds the limit', async () => {
    const { redis } = createFakeRedis(51);
    const result = await checkRateLimit(redis, '1.2.3.4', 50);
    expect(result.allowed).toBe(false);
  });

  it('passes the IP-scoped key and window into the Lua script', async () => {
    const { redis, eval: evalFn } = createFakeRedis(1);
    await checkRateLimit(redis, '5.6.7.8', 50, 2);
    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, 'ratelimit:5.6.7.8', 2);
  });

  it('throws instead of silently treating a malformed script result as a count', async () => {
    const { redis } = createFakeRedis('not-a-number');
    await expect(checkRateLimit(redis, '1.2.3.4', 50)).rejects.toThrow(TypeError);
  });
});
