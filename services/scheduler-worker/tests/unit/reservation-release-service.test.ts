import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReservationReleaseJob } from '../../src/services/reservation-release-service.js';

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

    const timer = startReservationReleaseJob(shardPools, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(warn).toHaveBeenCalled();
    clearInterval(timer);
  });
});
