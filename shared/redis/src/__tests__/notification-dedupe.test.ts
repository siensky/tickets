import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { claimNotification } from '../notification-dedupe.js';

function createFakeRedis(evalResult: unknown): Redis {
  return { eval: vi.fn().mockResolvedValue(evalResult) } as unknown as Redis;
}

describe('claimNotification', () => {
  it('returns true the first time a message id is claimed', async () => {
    const redis = createFakeRedis(1);
    await expect(claimNotification(redis, 'msg-1', 60)).resolves.toBe(true);
  });

  it('returns false when the message id was already claimed', async () => {
    const redis = createFakeRedis(0);
    await expect(claimNotification(redis, 'msg-1', 60)).resolves.toBe(false);
  });

  it('throws instead of silently treating a malformed script result as a claim', async () => {
    const redis = createFakeRedis(null);
    await expect(claimNotification(redis, 'msg-1', 60)).rejects.toThrow(TypeError);
  });
});
