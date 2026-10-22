import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { getCachedConfigValue } from '../config-cache.js';

describe('getCachedConfigValue', () => {
  it('returns the cached value without calling the loader on a cache hit', async () => {
    const get = vi.fn().mockResolvedValue('300');
    const set = vi.fn();
    const redis = { get, set } as unknown as Redis;
    const loadFromSource = vi.fn().mockResolvedValue('999');

    const value = await getCachedConfigValue(redis, 'admission_rate', 5, loadFromSource);

    expect(value).toBe('300');
    expect(loadFromSource).not.toHaveBeenCalled();
  });

  it('loads from the source and populates the cache on a miss', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const set = vi.fn().mockResolvedValue('OK');
    const redis = { get, set } as unknown as Redis;
    const loadFromSource = vi.fn().mockResolvedValue('300');

    const value = await getCachedConfigValue(redis, 'admission_rate', 5, loadFromSource);

    expect(value).toBe('300');
    expect(set).toHaveBeenCalledWith('config:admission_rate', '300', 'EX', 5);
  });
});
