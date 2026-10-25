import { ValidationError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import { markSeat } from '../../src/services/seat-mark-service.js';

const SILENT_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function fakeRedis(alreadyMarkedSeatIds: readonly string[]): RedisClient {
  return {
    smembers: vi.fn().mockResolvedValue(alreadyMarkedSeatIds),
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  } as unknown as RedisClient;
}

describe('markSeat', () => {
  it('allows marking a 5th distinct seat', async () => {
    const redis = fakeRedis(['s1', 's2', 's3', 's4']);

    await expect(
      markSeat(
        { redis, logger: SILENT_LOGGER },
        { eventId: 'e1', queueTokenId: 'q1', seatId: 's5' },
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects marking a 6th distinct seat', async () => {
    const redis = fakeRedis(['s1', 's2', 's3', 's4', 's5']);

    await expect(
      markSeat(
        { redis, logger: SILENT_LOGGER },
        { eventId: 'e1', queueTokenId: 'q1', seatId: 's6' },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('allows re-marking a seat that is already one of the 5', async () => {
    const redis = fakeRedis(['s1', 's2', 's3', 's4', 's5']);

    await expect(
      markSeat(
        { redis, logger: SILENT_LOGGER },
        { eventId: 'e1', queueTokenId: 'q1', seatId: 's1' },
      ),
    ).resolves.toBeUndefined();
  });
});
