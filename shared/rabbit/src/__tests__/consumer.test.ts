import { describe, expect, it, vi } from 'vitest';

const assertExchange = vi.fn().mockResolvedValue(undefined);
const assertQueue = vi.fn().mockResolvedValue(undefined);
const bindQueue = vi.fn().mockResolvedValue(undefined);
const prefetch = vi.fn().mockResolvedValue(undefined);
const ack = vi.fn();
const nack = vi.fn();
const channelClose = vi.fn().mockResolvedValue(undefined);
const channelOn = vi.fn();

let registeredConsumer: ((message: unknown) => void) | undefined;
const consume = vi.fn((_queue: string, onMessage: (message: unknown) => void) => {
  registeredConsumer = onMessage;
  return Promise.resolve();
});

const createChannel = vi.fn().mockResolvedValue({
  assertExchange,
  assertQueue,
  bindQueue,
  prefetch,
  consume,
  ack,
  nack,
  close: channelClose,
  on: channelOn,
});
const connectionClose = vi.fn().mockResolvedValue(undefined);
const connectionHandlers = new Map<string, (...args: unknown[]) => void>();
const connectionOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  connectionHandlers.set(event, handler);
});
const connect = vi.fn().mockResolvedValue({
  createChannel,
  close: connectionClose,
  on: connectionOn,
});

vi.mock('amqplib', () => ({ connect }));

const { connectConsumer } = await import('../consumer.js');

function fakeMessage(
  payload: unknown,
  messageId?: string,
): {
  content: Buffer;
  properties: { messageId: string | undefined };
} {
  return { content: Buffer.from(JSON.stringify(payload)), properties: { messageId } };
}

describe('connectConsumer', () => {
  const options = {
    exchange: 'domain-events',
    queue: 'notification-worker',
    routingKey: 'reservation.created',
    deliveryLimit: 5,
  };

  it('declares a quorum queue with the configured delivery-limit and binds it to the routing key', async () => {
    await connectConsumer(
      'amqp://fake',
      options,
      () => Promise.resolve(),
      () => undefined,
    );

    expect(assertQueue).toHaveBeenCalledWith('notification-worker', {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 5 },
    });
    expect(bindQueue).toHaveBeenCalledWith(
      'notification-worker',
      'domain-events',
      'reservation.created',
    );
  });

  it('acks the message once the handler resolves', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await connectConsumer('amqp://fake', options, handler, () => undefined);

    const message = fakeMessage({ reservationId: 'r-1' }, 'evt-1');
    registeredConsumer?.(message);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(message));

    expect(handler).toHaveBeenCalledWith({ reservationId: 'r-1' }, 'evt-1');
  });

  it('nacks with requeue=true and reports the error when the handler throws, instead of acking a dropped message', async () => {
    const handlerError = new Error('boom');
    const handler = vi.fn().mockRejectedValue(handlerError);
    const onHandlerError = vi.fn();
    await connectConsumer('amqp://fake', options, handler, onHandlerError);

    const message = fakeMessage({ reservationId: 'r-1' }, 'evt-1');
    registeredConsumer?.(message);
    await vi.waitFor(() => expect(nack).toHaveBeenCalledWith(message, false, true));

    expect(ack).not.toHaveBeenCalledWith(message);
    expect(onHandlerError).toHaveBeenCalledWith(handlerError, 'evt-1');
  });

  it('closes the channel then the connection', async () => {
    const consumer = await connectConsumer(
      'amqp://fake',
      options,
      () => Promise.resolve(),
      () => undefined,
    );
    await consumer.close();

    expect(channelClose).toHaveBeenCalledOnce();
    expect(connectionClose).toHaveBeenCalledOnce();
  });

  it('reconnects with backoff and resubscribes after the connection is unexpectedly closed', async () => {
    vi.useFakeTimers();
    try {
      const onConnectionError = vi.fn();
      await connectConsumer(
        'amqp://fake',
        options,
        () => Promise.resolve(),
        () => undefined,
        onConnectionError,
      );

      connect.mockClear();
      consume.mockClear();

      connectionHandlers.get('close')?.();
      await vi.advanceTimersByTimeAsync(1000);

      expect(onConnectionError).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(consume).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after an intentional close()', async () => {
    const consumer = await connectConsumer(
      'amqp://fake',
      options,
      () => Promise.resolve(),
      () => undefined,
    );
    await consumer.close();

    connect.mockClear();
    connectionHandlers.get('close')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connect).not.toHaveBeenCalled();
  });
});
