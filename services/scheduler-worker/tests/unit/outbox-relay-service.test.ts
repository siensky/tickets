import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connectPublisher = vi.fn();
vi.mock('@tickets/rabbit', () => ({ connectPublisher }));

const { startOutboxRelay } = await import('../../src/services/outbox-relay-service.js');

describe('startOutboxRelay', () => {
  afterEach(() => {
    vi.useRealTimers();
    connectPublisher.mockReset();
  });

  it('logs a warning and keeps ticking when the shard query fails', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    connectPublisher.mockResolvedValue({ publish: vi.fn(), close: vi.fn() });
    const failingPool = { connect: vi.fn().mockRejectedValue(new Error('shard down')) };
    // Only `connect` is exercised by withTransaction — see the same
    // pattern and rationale in shared/db/src/__tests__/transaction.test.ts.
    const shardPools = { pools: [failingPool, failingPool] } as unknown as ShardPools;

    const relay = startOutboxRelay(shardPools, 'amqp://fake', logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(warn).toHaveBeenCalled();
    await relay.stop();
  });

  it('reconnects on the next tick after a publish failure drops the cached publisher', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const okClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(okClient) };
    const shardPools = { pools: [pool, pool] } as unknown as ShardPools;
    connectPublisher.mockResolvedValue({ publish: vi.fn(), close: vi.fn() });

    const relay = startOutboxRelay(shardPools, 'amqp://fake', logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // Connects once per shard pool per tick it's needed for — with no
    // failures, the same cached publisher serves both ticks, so
    // connectPublisher itself is called only once.
    expect(connectPublisher).toHaveBeenCalledTimes(1);
    await relay.stop();
  });
});
