import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  clearSeatMarkHolders,
  getMarkedSeats,
  getSeatMarkHolders,
  markSeat,
  unmarkSeat,
} from '../seat-marks.js';

const EVENT_ID = 'event-1';
const SEAT_ID = 'seat-1';
const QUEUE_TOKEN_ID = 'queue-token-1';

function fakeRedis(): {
  redis: Redis;
  sadd: ReturnType<typeof vi.fn>;
  srem: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  smembers: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const sadd = vi.fn().mockResolvedValue(1);
  const srem = vi.fn().mockResolvedValue(1);
  const expire = vi.fn().mockResolvedValue(1);
  const smembers = vi.fn().mockResolvedValue([]);
  const del = vi.fn().mockResolvedValue(1);
  const redis = { sadd, srem, expire, smembers, del } as unknown as Redis;
  return { redis, sadd, srem, expire, smembers, del };
}

describe('markSeat', () => {
  it('adds the seat to both the holder-owned set and the reverse index, with matching TTL', async () => {
    const { redis, sadd, expire } = fakeRedis();

    await markSeat(redis, EVENT_ID, QUEUE_TOKEN_ID, SEAT_ID, 300);

    expect(sadd).toHaveBeenCalledWith(`seatmarks:${QUEUE_TOKEN_ID}`, SEAT_ID);
    expect(sadd).toHaveBeenCalledWith(
      `seatmark-holders:${EVENT_ID}:${SEAT_ID}`,
      QUEUE_TOKEN_ID,
    );
    expect(expire).toHaveBeenCalledWith(`seatmarks:${QUEUE_TOKEN_ID}`, 300);
    expect(expire).toHaveBeenCalledWith(`seatmark-holders:${EVENT_ID}:${SEAT_ID}`, 300);
  });
});

describe('unmarkSeat', () => {
  it('removes the seat from both sets', async () => {
    const { redis, srem } = fakeRedis();

    await unmarkSeat(redis, EVENT_ID, QUEUE_TOKEN_ID, SEAT_ID);

    expect(srem).toHaveBeenCalledWith(`seatmarks:${QUEUE_TOKEN_ID}`, SEAT_ID);
    expect(srem).toHaveBeenCalledWith(
      `seatmark-holders:${EVENT_ID}:${SEAT_ID}`,
      QUEUE_TOKEN_ID,
    );
  });
});

describe('getMarkedSeats', () => {
  it('reads the holder-owned set', async () => {
    const { redis, smembers } = fakeRedis();
    smembers.mockResolvedValue([SEAT_ID]);

    expect(await getMarkedSeats(redis, QUEUE_TOKEN_ID)).toEqual([SEAT_ID]);
    expect(smembers).toHaveBeenCalledWith(`seatmarks:${QUEUE_TOKEN_ID}`);
  });
});

describe('getSeatMarkHolders', () => {
  it('reads the reverse index', async () => {
    const { redis, smembers } = fakeRedis();
    smembers.mockResolvedValue([QUEUE_TOKEN_ID]);

    expect(await getSeatMarkHolders(redis, EVENT_ID, SEAT_ID)).toEqual([QUEUE_TOKEN_ID]);
    expect(smembers).toHaveBeenCalledWith(`seatmark-holders:${EVENT_ID}:${SEAT_ID}`);
  });
});

describe('clearSeatMarkHolders', () => {
  it('deletes the reverse index and removes the seat from every former holder', async () => {
    const { redis, del, srem } = fakeRedis();
    const otherQueueTokenId = 'queue-token-2';

    await clearSeatMarkHolders(redis, EVENT_ID, SEAT_ID, [QUEUE_TOKEN_ID, otherQueueTokenId]);

    expect(del).toHaveBeenCalledWith(`seatmark-holders:${EVENT_ID}:${SEAT_ID}`);
    expect(srem).toHaveBeenCalledWith(`seatmarks:${QUEUE_TOKEN_ID}`, SEAT_ID);
    expect(srem).toHaveBeenCalledWith(`seatmarks:${otherQueueTokenId}`, SEAT_ID);
  });

  it('does nothing beyond the delete when there are no holders', async () => {
    const { redis, del, srem } = fakeRedis();

    await clearSeatMarkHolders(redis, EVENT_ID, SEAT_ID, []);

    expect(del).toHaveBeenCalledTimes(1);
    expect(srem).not.toHaveBeenCalled();
  });
});
