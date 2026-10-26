import type { RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import { startWsSubscriberRegistry } from '../../src/services/ws-subscriber-registry.js';

// subscribeToChannelPrefix (@tickets/redis) duplicates the connection
// and listens for 'pmessage' — the fake only needs to satisfy that one
// call, the registry's own dispatch/registration logic is what's under
// test here.
function fakeRedis(): {
  redis: RedisClient;
  emitPMessage: (channel: string, payload: unknown) => void;
  psubscribe: ReturnType<typeof vi.fn>;
  punsubscribe: ReturnType<typeof vi.fn>;
} {
  let pmessageHandler: ((pattern: string, channel: string, raw: string) => void) | undefined;
  const psubscribe = vi.fn().mockResolvedValue(undefined);
  const punsubscribe = vi.fn().mockResolvedValue(undefined);
  const subscriber = {
    on: vi.fn((event: string, handler: typeof pmessageHandler) => {
      if (event === 'pmessage') {
        pmessageHandler = handler;
      }
    }),
    psubscribe,
    punsubscribe,
    quit: vi.fn().mockResolvedValue(undefined),
  };
  const redis = { duplicate: vi.fn().mockReturnValue(subscriber) } as unknown as RedisClient;
  return {
    redis,
    psubscribe,
    punsubscribe,
    emitPMessage: (channel, payload) =>
      pmessageHandler?.('ws:*', channel, JSON.stringify(payload)),
  };
}

describe('startWsSubscriberRegistry', () => {
  it('subscribes once to the ws:* pattern', async () => {
    const { redis, psubscribe } = fakeRedis();

    await startWsSubscriberRegistry(redis);

    expect(psubscribe).toHaveBeenCalledWith('ws:*');
  });

  it('dispatches a published message only to handlers registered for that queue token id', async () => {
    const { redis, emitPMessage } = fakeRedis();
    const registry = await startWsSubscriberRegistry(redis);
    const tokenAHandler = vi.fn();
    const tokenBHandler = vi.fn();
    registry.register('token-a', tokenAHandler);
    registry.register('token-b', tokenBHandler);

    emitPMessage('ws:token-a', { type: 'admitted' });

    expect(tokenAHandler).toHaveBeenCalledWith({ type: 'admitted' });
    expect(tokenBHandler).not.toHaveBeenCalled();
  });

  it('delivers to every handler registered for the same queue token id', async () => {
    const { redis, emitPMessage } = fakeRedis();
    const registry = await startWsSubscriberRegistry(redis);
    const first = vi.fn();
    const second = vi.fn();
    registry.register('token-a', first);
    registry.register('token-a', second);

    emitPMessage('ws:token-a', { type: 'admitted' });

    expect(first).toHaveBeenCalledWith({ type: 'admitted' });
    expect(second).toHaveBeenCalledWith({ type: 'admitted' });
  });

  it('stops delivering to a handler after it unregisters', async () => {
    const { redis, emitPMessage } = fakeRedis();
    const registry = await startWsSubscriberRegistry(redis);
    const handler = vi.fn();
    const unregister = registry.register('token-a', handler);

    unregister();
    emitPMessage('ws:token-a', { type: 'admitted' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a message for a queue token id with no registered handler', async () => {
    const { redis, emitPMessage } = fakeRedis();
    await startWsSubscriberRegistry(redis);

    expect(() => emitPMessage('ws:nobody-listening', { type: 'admitted' })).not.toThrow();
  });

  it('unsubscribes the shared connection on close', async () => {
    const { redis, punsubscribe } = fakeRedis();
    const registry = await startWsSubscriberRegistry(redis);

    await registry.close();

    expect(punsubscribe).toHaveBeenCalledWith('ws:*');
  });
});
