import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReservationReleaseJob } from '../../src/services/reservation-release-service.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('startReservationReleaseJob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs a warning and keeps ticking when a shard query fails', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const failingPool = { connect: vi.fn().mockRejectedValue(new Error('shard down')) };
    // Only `connect` is exercised by withTransaction — see the same
    // pattern and rationale in shared/db/src/__tests__/transaction.test.ts.
    const shardPools = { pools: [failingPool, failingPool] } as unknown as ShardPools;

    const job = startReservationReleaseJob(shardPools, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(warn).toHaveBeenCalled();
    await job.stop();
  });

  it('keeps draining batches within one tick until a batch comes back empty', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Three non-empty batches, then empty — the loop must stop there,
    // not after a single batch and not for the full MAX_BATCHES_PER_TICK cap.
    const batches = [['r-1'], ['r-2'], ['r-3'], []];
    let call = 0;
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('WITH due AS')) {
        const ids = batches[call] ?? [];
        call++;
        return Promise.resolve({ rows: ids.map((id) => ({ id })) });
      }
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    // A single pool here — the point is the batching LOOP, which is
    // identical regardless of shard count; multi-pool iteration is
    // already covered by the other tests in this file.
    const shardPools = { pools: [pool] } as unknown as ShardPools;

    const job = startReservationReleaseJob(shardPools, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await job.stop();

    // 3 non-empty batches, then 1 empty batch that stops the loop.
    expect(call).toBe(4);
  });

  it('stop() waits for an in-flight tick to finish before resolving', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const stall = deferred<{ rows: { id: string }[] }>();
    const query = vi.fn().mockReturnValue(stall.promise);
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const shardPools = { pools: [pool] } as unknown as ShardPools;

    const job = startReservationReleaseJob(shardPools, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000); // tick starts, stuck mid-batch

    let stopResolved = false;
    const stopPromise = job.stop().then(() => {
      stopResolved = true;
    });

    expect(stopResolved).toBe(false);
    stall.resolve({ rows: [] });
    await stopPromise;

    expect(stopResolved).toBe(true);
  });
});
