import { describe, expect, it, vi } from 'vitest';

const assertExchange = vi.fn().mockResolvedValue(undefined);
// Mirrors amqplib's ConfirmChannel: publish() takes a callback that
// fires once the broker confirms — invoke it synchronously with "no
// error" by default, matching the happy path.
const publish = vi.fn(
  (
    _exchange: string,
    _routingKey: string,
    _content: Buffer,
    _options: unknown,
    callback: (err: unknown) => void,
  ) => {
    callback(null);
    return true;
  },
);
const channelClose = vi.fn().mockResolvedValue(undefined);
const createConfirmChannel = vi
  .fn()
  .mockResolvedValue({ assertExchange, publish, close: channelClose });
const connectionClose = vi.fn().mockResolvedValue(undefined);
const connect = vi.fn().mockResolvedValue({ createConfirmChannel, close: connectionClose });

vi.mock('amqplib', () => ({ connect }));

const { connectPublisher } = await import('../publisher.js');

describe('connectPublisher', () => {
  it('asserts the exchange once, publishes JSON content, and sets the messageId property', async () => {
    const publisher = await connectPublisher('amqp://fake');

    await publisher.publish(
      'domain-events',
      'reservation.created',
      { reservationId: 'r-1' },
      { messageId: 'evt-1' },
    );
    await publisher.publish(
      'domain-events',
      'reservation.created',
      { reservationId: 'r-2' },
      { messageId: 'evt-2' },
    );

    expect(assertExchange).toHaveBeenCalledOnce();
    expect(assertExchange).toHaveBeenCalledWith('domain-events', 'topic', { durable: true });
    expect(publish).toHaveBeenCalledTimes(2);
    const [, , firstContent, firstOptions] = publish.mock.calls[0] as unknown as [
      string,
      string,
      Buffer,
      { messageId: string },
    ];
    expect(JSON.parse(firstContent.toString())).toEqual({ reservationId: 'r-1' });
    expect(firstOptions.messageId).toBe('evt-1');
  });

  it('rejects when the broker nacks the publish instead of confirming it', async () => {
    publish.mockImplementationOnce(
      (_exchange, _routingKey, _content, _options, callback: (err: unknown) => void) => {
        callback(new Error('nack'));
        return true;
      },
    );
    const publisher = await connectPublisher('amqp://fake');

    await expect(publisher.publish('domain-events', 'x', {})).rejects.toThrow(
      'did not confirm',
    );
  });

  it('closes the channel then the connection', async () => {
    const publisher = await connectPublisher('amqp://fake');
    await publisher.close();

    expect(channelClose).toHaveBeenCalledOnce();
    expect(connectionClose).toHaveBeenCalledOnce();
  });
});
