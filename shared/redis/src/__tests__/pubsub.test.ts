import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { subscribeToChannelPrefix } from '../pubsub.js';

describe('subscribeToChannelPrefix', () => {
  it('psubscribes on a duplicated connection and parses matching pmessages', async () => {
    let pmessageHandler: ((pattern: string, channel: string, raw: string) => void) | undefined;
    const psubscribe = vi.fn().mockResolvedValue(undefined);
    const subscriber = {
      on: vi.fn((event: string, handler: typeof pmessageHandler) => {
        if (event === 'pmessage') {
          pmessageHandler = handler;
        }
      }),
      psubscribe,
      punsubscribe: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
    };
    const redis = { duplicate: vi.fn().mockReturnValue(subscriber) } as unknown as Redis;
    const onMessage = vi.fn();

    await subscribeToChannelPrefix(redis, 'ws:*', onMessage);
    pmessageHandler?.('ws:*', 'ws:token-a', JSON.stringify({ type: 'admitted' }));

    expect(psubscribe).toHaveBeenCalledWith('ws:*');
    expect(onMessage).toHaveBeenCalledWith('ws:token-a', { type: 'admitted' });
  });

  it('unsubscribe punsubscribes and closes the duplicated connection', async () => {
    const punsubscribe = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn().mockResolvedValue(undefined);
    const subscriber = {
      on: vi.fn(),
      psubscribe: vi.fn().mockResolvedValue(undefined),
      punsubscribe,
      quit,
    };
    const redis = { duplicate: vi.fn().mockReturnValue(subscriber) } as unknown as Redis;

    const subscription = await subscribeToChannelPrefix(redis, 'ws:*', vi.fn());
    await subscription.unsubscribe();

    expect(punsubscribe).toHaveBeenCalledWith('ws:*');
    expect(quit).toHaveBeenCalledOnce();
  });
});
