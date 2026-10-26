import type { ShardPools } from '@tickets/db';
import { createBusinessMetrics, createLogger, createRegistry } from '@tickets/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBusinessMetricsJob } from '../../src/services/business-metrics-service.js';

describe('startBusinessMetricsJob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets active_reservations/sold_tickets from both shards', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const registry = createRegistry('test');
    const metrics = createBusinessMetrics(registry);
    const poolShard0 = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM reservations')) {
          return Promise.resolve({ rows: [{ event_id: 'event-1', count: '3' }] });
        }
        return Promise.resolve({ rows: [{ event_id: 'event-1', count: '42' }] });
      }),
    };
    const poolShard1 = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const shardPools = { pools: [poolShard0, poolShard1] } as unknown as ShardPools;

    const job = startBusinessMetricsJob(shardPools, metrics, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await job.stop();

    const output = await registry.metrics();
    expect(output).toContain('active_reservations{event_id="event-1",service="test"} 3');
    expect(output).toContain('sold_tickets{event_id="event-1",service="test"} 42');
  });

  it('resets a gauge to empty once its event no longer appears in the query result', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const registry = createRegistry('test');
    const metrics = createBusinessMetrics(registry);
    // Controlled explicitly across the two ticks, instead of an
    // auto-incrementing call counter — one `runTick()` already makes
    // several `pool.query` calls (two shards × two queries each), so a
    // naive "Nth call" counter can't line up with "Nth interval tick".
    let hasReservation = true;
    const pool = {
      query: vi.fn().mockImplementation((sql: string) =>
        Promise.resolve({
          rows:
            hasReservation && sql.includes('FROM reservations')
              ? [{ event_id: 'event-1', count: '1' }]
              : [],
        }),
      ),
    };
    const shardPools = { pools: [pool, pool] } as unknown as ShardPools;

    const job = startBusinessMetricsJob(shardPools, metrics, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await registry.metrics()).toContain(
      'active_reservations{event_id="event-1",service="test"} 1',
    );

    hasReservation = false;
    await vi.advanceTimersByTimeAsync(1000);
    await job.stop();

    expect(await registry.metrics()).not.toContain('event_id="event-1"');
  });

  it('logs a warning and keeps ticking when a shard query fails', async () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const registry = createRegistry('test');
    const metrics = createBusinessMetrics(registry);
    const failingPool = { query: vi.fn().mockRejectedValue(new Error('shard down')) };
    const shardPools = { pools: [failingPool, failingPool] } as unknown as ShardPools;

    const job = startBusinessMetricsJob(shardPools, metrics, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await job.stop();

    expect(warn).toHaveBeenCalled();
  });
});
