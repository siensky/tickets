import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitNextBatch,
  drainWaitingRoom,
  getWaitingRoomStatus,
  joinOrAdmitWaitingRoom,
  touchAdmittedActivity,
} from '../waiting-room.js';

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

    const result = await admitNextBatch(redis, 'event-1', 2, 600, 600);

    expect(result).toEqual({
      admittedQueueTokenIds: ['token-a', 'token-b'],
      remainingDepth: 3,
    });
    expect(set).toHaveBeenCalledWith(
      'admitted:event-1:token-a',
      expect.any(String),
      'EX',
      600,
    );
    expect(set).toHaveBeenCalledWith(
      'admitted:event-1:token-b',
      expect.any(String),
      'EX',
      600,
    );
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

    const result = await admitNextBatch(redis, 'event-1', 5, 600, 600);

    expect(result.remainingDepth).toBe(0);
    expect(srem).toHaveBeenCalledWith('waitingroom:active-events', 'event-1');
  });

  it('admits someone who has waited for hours: there is no age limit in the queue', async () => {
    const twoHoursAgo = String(Date.now() - 2 * 60 * 60_000);
    const set = vi.fn().mockResolvedValue('OK');
    const redis = {
      zpopmin: vi.fn().mockResolvedValue(['patient-token', twoHoursAgo]),
      set,
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(0),
      srem: vi.fn(),
    } as unknown as Redis;

    const result = await admitNextBatch(redis, 'event-1', 1, 600, 600);

    expect(result.admittedQueueTokenIds).toEqual(['patient-token']);
    expect(set).toHaveBeenCalledWith(
      'admitted:event-1:patient-token',
      expect.any(String),
      'EX',
      600,
    );
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

describe('bokningsfönstret räknas från insläppet', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lagrar insläppets slutdatum som värde och klipper TTL mot bokningsfönstret', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const set = vi.fn().mockResolvedValue('OK');
    const redis = {
      zpopmin: vi.fn().mockResolvedValue(['token-a', String(Date.now())]),
      set,
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(1),
      srem: vi.fn(),
    } as unknown as Redis;

    // Inaktivitet 20 min, bokningsfönster 10 min: det kortaste gäller.
    await admitNextBatch(redis, 'event-1', 1, 1200, 600);

    const deadline = String(Date.now() + 600_000);
    expect(set).toHaveBeenCalledWith('admitted:event-1:token-a', deadline, 'EX', 600);
  });

  it('en lång kötid äter inte av bokningsfönstret: fönstret startar vid insläppet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const set = vi.fn().mockResolvedValue('OK');
    // Köade för 14 min sedan men släpps in nu.
    const joinedAt = String(Date.now() - 14 * 60_000);
    const redis = {
      zpopmin: vi.fn().mockResolvedValue(['token-a', joinedAt]),
      set,
      zadd: vi.fn().mockResolvedValue(1),
      zcard: vi.fn().mockResolvedValue(1),
      srem: vi.fn(),
    } as unknown as Redis;

    await admitNextBatch(redis, 'event-1', 1, 600, 600);

    expect(set).toHaveBeenCalledWith(
      'admitted:event-1:token-a',
      String(Date.now() + 600_000),
      'EX',
      600,
    );
  });

  it('direktinsläpp sätter samma slutdatum och TTL via Lua-skriptet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const evalMock = vi.fn().mockResolvedValue(1);
    const redis = { eval: evalMock } as unknown as Redis;

    const result = await joinOrAdmitWaitingRoom(redis, 'event-1', 'token-a', 1000, 1200, 600);

    expect(result).toBe('admitted');
    const args = evalMock.mock.calls[0] as unknown[];
    // [script, numKeys, 4 nycklar, tokenId, now, limit, ttl, eventId, deadline]
    expect(args.slice(6)).toEqual([
      'token-a',
      Date.now(),
      1000,
      600,
      'event-1',
      Date.now() + 600_000,
    ]);
  });
});

describe('touchAdmittedActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function redisWith(rawValue: string | null) {
    const expire = vi.fn().mockResolvedValue(1);
    const zadd = vi.fn().mockResolvedValue(1);
    const redis = {
      get: vi.fn().mockResolvedValue(rawValue),
      expire,
      zadd,
    } as unknown as Redis;
    return { redis, expire, zadd };
  }

  it('förnyar inaktivitetsfönstret när det ryms inom bokningsfönstret', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const { redis, expire } = redisWith(String(Date.now() + 9 * 60_000));

    await touchAdmittedActivity(redis, 'event-1', 'token-a', 120);

    expect(expire).toHaveBeenCalledWith('admitted:event-1:token-a', 120);
  });

  it('klipper förnyelsen mot slutdatumet så fönstret aldrig kan förlängas', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const { redis, expire, zadd } = redisWith(String(Date.now() + 45_000));

    await touchAdmittedActivity(redis, 'event-1', 'token-a', 600);

    expect(expire).toHaveBeenCalledWith('admitted:event-1:token-a', 45);
    expect(zadd).toHaveBeenCalledWith(
      'admitted-index:event-1',
      'XX',
      Date.now() + 45_000,
      'token-a',
    );
  });

  it('förnyar inte alls när slutdatumet passerat eller är under en sekund bort', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    for (const offsetMs of [-5_000, 400]) {
      const { redis, expire } = redisWith(String(Date.now() + offsetMs));
      await touchAdmittedActivity(redis, 'event-1', 'token-a', 600);
      expect(expire).not.toHaveBeenCalled();
    }
  });

  it('gör ingenting när nyckeln redan har gått ut', async () => {
    const { redis, expire } = redisWith(null);

    await touchAdmittedActivity(redis, 'event-1', 'token-a', 600);

    expect(expire).not.toHaveBeenCalled();
  });

  it("slänger inte ut någon med ett äldre '1'-värde (nyckel från före bokningsfönstret)", async () => {
    const { redis, expire } = redisWith('1');

    await touchAdmittedActivity(redis, 'event-1', 'token-a', 600);

    expect(expire).toHaveBeenCalledWith('admitted:event-1:token-a', 600);
  });
});
