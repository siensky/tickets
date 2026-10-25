import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import { processNotificationEvent } from '../../src/services/notification-consumer-service.js';

function fakeRedis(isNew: boolean): RedisClient {
  return { eval: vi.fn().mockResolvedValue(isNew ? 1 : 0) } as unknown as RedisClient;
}

function fakeShardPools(options: { userEmail?: string; orderUserId?: string }): ShardPools {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM users')) {
      return Promise.resolve({
        rows: options.userEmail !== undefined ? [{ email: options.userEmail }] : [],
      });
    }
    if (sql.includes('FROM orders')) {
      return Promise.resolve({
        rows: options.orderUserId !== undefined ? [{ user_id: options.orderUserId }] : [],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  const pool = { query };
  return { pools: [pool, pool] } as unknown as ShardPools;
}

describe('processNotificationEvent', () => {
  it('throws when the message has no messageId', async () => {
    const shardPools = fakeShardPools({});
    const redis = fakeRedis(true);
    const logger = createLogger({ serviceName: 'test' });

    await expect(
      processNotificationEvent({ shardPools, redis, logger }, { ticketIds: [] }, undefined),
    ).rejects.toThrow();
  });

  it('skips processing entirely when the message was already claimed (dedupe)', async () => {
    const shardPools = fakeShardPools({ userEmail: 'user@example.test' });
    const redis = fakeRedis(false);
    const logger = createLogger({ serviceName: 'test' });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await processNotificationEvent(
      { shardPools, redis, logger },
      { orderId: 'order-1', eventId: 'event-1', userId: 'user-1', ticketIds: ['t-1'] },
      'msg-1',
    );

    expect(info).not.toHaveBeenCalled();
  });

  it('sends an order confirmation for an order.confirmed-shaped payload', async () => {
    const shardPools = fakeShardPools({ userEmail: 'user@example.test' });
    const redis = fakeRedis(true);
    const logger = createLogger({ serviceName: 'test' });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await processNotificationEvent(
      { shardPools, redis, logger },
      { orderId: 'order-1', eventId: 'event-1', userId: 'user-1', ticketIds: ['t-1', 't-2'] },
      'msg-1',
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.test',
        orderId: 'order-1',
        ticketCount: 2,
      }),
      expect.stringContaining('confirmation'),
    );
  });

  it('sends a refund explanation for an order.refunded-shaped payload, looking the user up via the order', async () => {
    const shardPools = fakeShardPools({
      userEmail: 'user@example.test',
      orderUserId: 'user-1',
    });
    const redis = fakeRedis(true);
    const logger = createLogger({ serviceName: 'test' });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await processNotificationEvent(
      { shardPools, redis, logger },
      {
        orderId: 'order-1',
        eventId: 'event-1',
        paymentId: 'payment-1',
        reservationId: 'res-1',
      },
      'msg-1',
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user@example.test', orderId: 'order-1' }),
      expect.stringContaining('refund'),
    );
  });

  it('sends a seat-refund explanation for an order.seat_refunded-shaped payload, not the full-refund one', async () => {
    const shardPools = fakeShardPools({
      userEmail: 'user@example.test',
      orderUserId: 'user-1',
    });
    const redis = fakeRedis(true);
    const logger = createLogger({ serviceName: 'test' });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await processNotificationEvent(
      { shardPools, redis, logger },
      {
        orderId: 'order-1',
        eventId: 'event-1',
        paymentId: 'payment-1',
        seatIds: ['seat-2'],
        amountCents: 1000,
      },
      'msg-1',
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.test',
        orderId: 'order-1',
        seatCount: 1,
      }),
      expect.stringContaining('partial seat refund'),
    );
  });

  it('warns instead of throwing for an unrecognized payload shape', async () => {
    const shardPools = fakeShardPools({});
    const redis = fakeRedis(true);
    const logger = createLogger({ serviceName: 'test' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await processNotificationEvent(
      { shardPools, redis, logger },
      { unexpected: true },
      'msg-1',
    );

    expect(warn).toHaveBeenCalled();
  });
});
