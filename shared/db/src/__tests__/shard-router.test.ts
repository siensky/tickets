import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashEventIdToShardIndex } from '../shard-router.js';

describe('hashEventIdToShardIndex', () => {
  it('always returns an index within [0, shardCount)', () => {
    for (let i = 0; i < 200; i++) {
      const index = hashEventIdToShardIndex(randomUUID(), 2);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(2);
    }
  });

  it('is deterministic for the same event_id', () => {
    const eventId = randomUUID();
    expect(hashEventIdToShardIndex(eventId, 2)).toBe(hashEventIdToShardIndex(eventId, 2));
  });

  it('distributes across both shards instead of collapsing to one', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(hashEventIdToShardIndex(randomUUID(), 2));
    }
    expect(seen).toEqual(new Set([0, 1]));
  });

  it('rejects a shard count below 1', () => {
    expect(() => hashEventIdToShardIndex(randomUUID(), 0)).toThrow(RangeError);
  });
});
