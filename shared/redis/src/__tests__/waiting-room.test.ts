import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { admitNextBatch, drainWaitingRoom, getWaitingRoomStatus } from '../waiting-room.js';

describe('getWaitingRoomStatus', () => {
  it('reports "admitted" without checking position once the admitted marker exists', async () => {
    const zrank = vi.fn();
    const redis = { exists: vi.fn().mockResolvedValue(1), zrank } as unknown as Redis;

    const status = await getWaitingRoomStatus(redis, 'event-1', 'token-1');

    expect(status).toEqual({ kind: 'admitted' });
    expect(zrank).not.toHaveBeenCalled();
  });

  it('reports 1-based position and queue depth while still waiting', async () => {
    const redis = {
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(0),
      zcard: vi.fn().mockResolvedValue(4823),
    } as unknown as Redis;

    const status = await getWaitingRoomStatus(redis, 'event-1', 'token-1');

    expect(status).toEqual({ kind: 'waiting', position: 1, queueDepth: 4823 });
  });

  it('reports "not_found" when the token is neither admitted nor in the queue', async () => {
    const redis = {
      exists: vi.fn().mockResolvedValue(0),
      zrank: vi.fn().mockResolvedValue(null),
    } as unknown as Redis;

    const status = await getWaitingRoomStatus(redis, 'event-1', 'ghost-token');

    expect(status).toEqual({ kind: 'not_found' });
  });
});

describe('admitNextBatch', () => {
  it('marks every popped member as admitted and keeps the active-events set when the queue is not empty', async () => {
    const now = Date.now();
    const set = vi.fn().mockResolvedValue('OK');
    const srem = vi.fn();
    const zadd = vi.fn().mockResolvedValue(1);
    const zpopmin = vi
      .fn()
      .mockResolvedValue(['token-a', String(now), 'token-b', String(now)]);
    const redis = {
      zpopmin,
      set,
      zadd,
      zcard: vi.fn().mockResolvedValue(3),
      srem,
    } as unknown as Redis;

    const result = await admitNextBatch(redis, 'event-1', 2, 600, 15);

    expect(result).toEqual({
      admittedQueueTokenIds: ['token-a', 'token-b'],
      remainingDepth: 3,
      prunedExpiredCount: 0,
    });
    expect(set).toHaveBeenCalledWith('admitted:event-1:token-a', '1', 'EX', 600);
    expect(set).toHaveBeenCalledWith('admitted:event-1:token-b', '1', 'EX', 600);
    expect(zadd).toHaveBeenCalledWith('admitted-index:event-1', expect.any(Number), 'token-a');
    expect(srem).not.toHaveBeenCalled();
    expect(zpopmin).toHaveBeenCalledTimes(1);
  });

  it('removes the event from the active-events set once the queue drains to empty', async () => {
    const srem = vi.fn();
    const redis = {
      zpopmin: vi.fn().mockResolvedValue(['token-a', String(Date.now())]),
      set: vi.fn().mockResolvedValue('OK'),
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(0),
      srem,
    } as unknown as Redis;

    const result = await admitNextBatch(redis, 'event-1', 5, 600, 15);

    expect(result.remainingDepth).toBe(0);
    expect(srem).toHaveBeenCalledWith('waitingroom:active-events', 'event-1');
  });

  it('skips an already-expired entry instead of admitting it, and does not waste the quota on it', async () => {
    const now = Date.now();
    const staleScore = String(now - 20 * 60_000); // 20 min gammal, sessionen är 15 min
    const set = vi.fn().mockResolvedValue('OK');
    const zpopmin = vi
      .fn()
      .mockResolvedValueOnce(['dead-token', staleScore])
      .mockResolvedValueOnce([]);
    const redis = {
      zpopmin,
      set,
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(0),
      srem: vi.fn(),
    } as unknown as Redis;

    const result = await admitNextBatch(redis, 'event-1', 1, 600, 15);

    expect(result.admittedQueueTokenIds).toEqual([]);
    expect(result.prunedExpiredCount).toBe(1);
    expect(set).not.toHaveBeenCalled();
    // Letar vidare efter en levande post istället för att nöja sig med den döda.
    expect(zpopmin).toHaveBeenCalledTimes(2);
  });

  it('backfills the batch with the next live entry when an earlier pop was already expired', async () => {
    const now = Date.now();
    const staleScore = String(now - 20 * 60_000);
    const freshScore = String(now);
    const zpopmin = vi
      .fn()
      .mockResolvedValueOnce(['dead-token', staleScore])
      .mockResolvedValueOnce(['live-token', freshScore]);
    const set = vi.fn().mockResolvedValue('OK');
    const redis = {
      zpopmin,
      set,
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(0),
      srem: vi.fn(),
    } as unknown as Redis;

    const result = await admitNextBatch(redis, 'event-1', 1, 600, 15);

    expect(result.admittedQueueTokenIds).toEqual(['live-token']);
    expect(result.prunedExpiredCount).toBe(1);
    expect(set).toHaveBeenCalledWith('admitted:event-1:live-token', '1', 'EX', 600);
  });
});

describe('drainWaitingRoom', () => {
  it('returns every queued token and empties the queue without admitting anyone', async () => {
    const del = vi.fn();
    const srem = vi.fn();
    const redis = {
      zrange: vi.fn().mockResolvedValue(['token-a', 'token-b']),
      del,
      srem,
    } as unknown as Redis;

    const drained = await drainWaitingRoom(redis, 'event-1');

    expect(drained).toEqual(['token-a', 'token-b']);
    expect(del).toHaveBeenCalledWith('waitingroom:event-1');
    expect(srem).toHaveBeenCalledWith('waitingroom:active-events', 'event-1');
  });

  it('does not issue a DEL when the queue is already empty', async () => {
    const del = vi.fn();
    const redis = {
      zrange: vi.fn().mockResolvedValue([]),
      del,
      srem: vi.fn(),
    } as unknown as Redis;

    await drainWaitingRoom(redis, 'event-1');

    expect(del).not.toHaveBeenCalled();
  });
});
