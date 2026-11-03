import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESERVATION_RETENTION_DAYS,
  runReservationRetention,
  startReservationRetentionJob,
} from '../../src/services/reservation-retention-service.js';

function poolReturning(...rowCounts: number[]) {
  const query = vi.fn();
  for (const rowCount of rowCounts) {
    query.mockResolvedValueOnce({ rowCount });
  }
  return { query };
}

function silentLogger() {
  const logger = createLogger({ serviceName: 'test' });
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  return { logger, warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined) };
}

describe('runReservationRetention', () => {
  it('deletes batch after batch until one comes back short, and sums the result', async () => {
    const { logger } = silentLogger();
    const pool = poolReturning(1000, 1000, 17);
    const shardPools = { pools: [pool] } as unknown as ShardPools;

    const deleted = await runReservationRetention(shardPools, logger);

    expect(deleted).toBe(2017);
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[0]?.[1]).toEqual([RESERVATION_RETENTION_DAYS, 1000]);
  });

  it('stops after one batch when there is nothing old enough', async () => {
    const { logger } = silentLogger();
    const pool = poolReturning(0);

    const deleted = await runReservationRetention(
      { pools: [pool] } as unknown as ShardPools,
      logger,
    );

    expect(deleted).toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('keeps cleaning the other shard when one shard fails', async () => {
    const { logger, warn } = silentLogger();
    const failing = { query: vi.fn().mockRejectedValue(new Error('shard down')) };
    const healthy = poolReturning(5);

    const deleted = await runReservationRetention(
      { pools: [failing, healthy] } as unknown as ShardPools,
      logger,
    );

    expect(deleted).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(healthy.query).toHaveBeenCalledTimes(1);
  });
});

describe('startReservationRetentionJob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once at start and then every interval, never two ticks at once', async () => {
    vi.useFakeTimers();
    const { logger } = silentLogger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn().mockImplementation(async () => {
      await gate;
      return { rowCount: 0 };
    });

    const job = startReservationRetentionJob(
      { pools: [{ query }] } as unknown as ShardPools,
      logger,
      1000,
    );
    expect(query).toHaveBeenCalledTimes(1);

    // Första tick:en hänger fortfarande: nästa intervall ska hoppas över, inte köra parallellt.
    await vi.advanceTimersByTimeAsync(3000);
    expect(query).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(2);

    await job.stop();
  });
});
