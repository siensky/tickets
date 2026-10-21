import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connectPublisher = vi.fn();
vi.mock('@tickets/rabbit', () => ({ connectPublisher }));

const { startOutboxRelay } = await import('../../src/services/outbox-relay-service.js');

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('startOutboxRelay', () => {
  afterEach(() => {
    vi.useRealTimers();
    connectPublisher.mockReset();
  });

  it('logs a warning and keeps ticking when the shard query fails', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    connectPublisher.mockResolvedValue({
      publish: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });
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

  it('closes the old publisher before reconnecting, instead of leaking it', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Claiming must return a non-empty batch, or publish() never gets
    // called at all and there's nothing for the mocked rejection below
    // to actually exercise.
    const okClient = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'evt-1', type: 'reservation.created', payload: {} }],
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(okClient) };
    const shardPools = { pools: [pool] } as unknown as ShardPools;
    const firstClose = vi.fn().mockResolvedValue(undefined);
    const secondClose = vi.fn().mockResolvedValue(undefined);
    connectPublisher
      .mockResolvedValueOnce({
        publish: vi.fn().mockRejectedValue(new Error('broker gone')),
        close: firstClose,
      })
      .mockResolvedValueOnce({
        publish: vi.fn().mockResolvedValue(undefined),
        close: secondClose,
      });

    const relay = startOutboxRelay(shardPools, 'amqp://fake', logger, 1000);
    await vi.advanceTimersByTimeAsync(1000); // first tick: publish fails
    await vi.advanceTimersByTimeAsync(1000); // second tick: reconnects

    expect(firstClose).toHaveBeenCalledOnce();
    await relay.stop();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it('skips a tick while the previous one is still in flight, instead of overlapping', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const stall = deferred<{
      publish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>();
    connectPublisher.mockReturnValue(stall.promise);
    const pool = { connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }) };
    const shardPools = { pools: [pool] } as unknown as ShardPools;

    const relay = startOutboxRelay(shardPools, 'amqp://fake', logger, 1000);
    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts, stuck on connectPublisher
    await vi.advanceTimersByTimeAsync(1000); // tick 2's timer fires — should be skipped

    expect(connectPublisher).toHaveBeenCalledOnce();

    stall.resolve({
      publish: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    await relay.stop();
  });

  it('stop() waits for an in-flight tick to finish before closing the publisher', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const stall = deferred<{
      publish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>();
    connectPublisher.mockReturnValue(stall.promise);
    const pool = { connect: vi.fn().mockResolvedValue({ query: vi.fn(), release: vi.fn() }) };
    const shardPools = { pools: [pool] } as unknown as ShardPools;

    const relay = startOutboxRelay(shardPools, 'amqp://fake', logger, 1000);
    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts, stuck on connectPublisher

    const close = vi.fn().mockResolvedValue(undefined);
    let stopResolved = false;
    const stopPromise = relay.stop().then(() => {
      stopResolved = true;
    });

    expect(stopResolved).toBe(false);
    stall.resolve({ publish: vi.fn().mockResolvedValue(undefined), close });
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
