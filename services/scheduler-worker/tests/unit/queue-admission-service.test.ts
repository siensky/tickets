import { describe, expect, it } from 'vitest';
import { batchSizeForTick } from '../../src/services/queue-admission-service.js';

describe('batchSizeForTick', () => {
  it('converts a per-minute rate into a proportional per-tick batch', () => {
    // 300/min över en 1000 ms tick = 5 per tick.
    expect(batchSizeForTick(300, 1000)).toBe(5);
  });

  it('never returns zero even for a very low rate or very short tick', () => {
    expect(batchSizeForTick(1, 1000)).toBe(1);
  });

  it('scales linearly with the tick interval', () => {
    expect(batchSizeForTick(300, 2000)).toBe(10);
  });
});
