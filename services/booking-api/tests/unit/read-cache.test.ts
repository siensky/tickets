import { describe, expect, it, vi } from 'vitest';
import { createReadCache, createSingleFlight } from '../../src/services/read-cache.js';

/** En styrbar klocka och en laddning vars löfte testet själv löser, så att samtidighet går att visa. */
function controllableClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createReadCache', () => {
  it('återanvänder ett värde inom TTL och laddar om efteråt', async () => {
    const clock = controllableClock();
    const cache = createReadCache<number>(2000, clock.now);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('e1', load)).toBe(1);
    clock.advance(1999);
    expect(await cache.get('e1', load)).toBe(1);
    clock.advance(1);
    expect(await cache.get('e1', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('låter samtidiga missar dela på EN laddning', async () => {
    const cache = createReadCache<string>(2000, controllableClock().now);
    const pending = deferred<string>();
    const load = vi.fn().mockReturnValue(pending.promise);

    const results = Promise.all([cache.get('e1', load), cache.get('e1', load)]);
    pending.resolve('svar');

    expect(await results).toEqual(['svar', 'svar']);
    expect(load).toHaveBeenCalledOnce();
  });

  it('cachar aldrig ett fel: nästa anrop laddar igen', async () => {
    const cache = createReadCache<string>(2000, controllableClock().now);
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValueOnce('ok');

    await expect(cache.get('e1', load)).rejects.toThrow('timeout exceeded');
    expect(await cache.get('e1', load)).toBe('ok');
  });

  it('håller olika nycklar isär', async () => {
    const cache = createReadCache<string>(2000, controllableClock().now);

    expect(await cache.get('e1', () => Promise.resolve('ett'))).toBe('ett');
    expect(await cache.get('e2', () => Promise.resolve('två'))).toBe('två');
  });

  it('trycker ut bara den äldsta nyckeln när taket på 1000 nås, inte alla', async () => {
    const cache = createReadCache<number>(60_000, controllableClock().now);
    for (let i = 0; i < 1000; i++) {
      await cache.get(`k${String(i)}`, () => Promise.resolve(i));
    }
    await cache.get('ny', () => Promise.resolve(1000));

    const reloadOldest = vi.fn().mockResolvedValue(0);
    const reloadSecond = vi.fn().mockResolvedValue(1);
    await cache.get('k1', reloadSecond);
    await cache.get('k0', reloadOldest);

    expect(reloadSecond).not.toHaveBeenCalled();
    expect(reloadOldest).toHaveBeenCalledOnce();
  });

  it('TTL 0 = avstängd: varje anrop laddar själv, även samtidiga', async () => {
    const cache = createReadCache<number>(0, controllableClock().now);
    const load = vi.fn().mockResolvedValue(1);

    await Promise.all([cache.get('e1', load), cache.get('e1', load)]);
    await cache.get('e1', load);

    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('createSingleFlight', () => {
  it('delar en pågående laddning men sparar inget när den är klar', async () => {
    const flight = createSingleFlight<string>();
    const pending = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce('nästa');

    const results = Promise.all([flight.get('k', load), flight.get('k', load)]);
    pending.resolve('första');

    expect(await results).toEqual(['första', 'första']);
    expect(await flight.get('k', load)).toBe('nästa');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('släpper nyckeln efter ett fel', async () => {
    const flight = createSingleFlight<string>();
    const pending = deferred<string>();
    const first = flight.get('k', () => pending.promise);
    pending.reject(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    expect(await flight.get('k', () => Promise.resolve('igen'))).toBe('igen');
  });
});
