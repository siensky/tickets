import { describe, expect, it, vi } from 'vitest';

const assertExchange = vi.fn().mockResolvedValue(undefined);
const publish = vi.fn().mockReturnValue(true);
const channelClose = vi.fn().mockResolvedValue(undefined);
const createChannel = vi
  .fn()
  .mockResolvedValue({ assertExchange, publish, close: channelClose });
const connectionClose = vi.fn().mockResolvedValue(undefined);
const connect = vi.fn().mockResolvedValue({ createChannel, close: connectionClose });

vi.mock('amqplib', () => ({ connect }));

const { connectPublisher } = await import('../publisher.js');

describe('connectPublisher', () => {
  it('asserts the exchange once and publishes JSON content', async () => {
    const publisher = await connectPublisher('amqp://fake');

    await publisher.publish('domain-events', 'reservation.created', { reservationId: 'r-1' });
    await publisher.publish('domain-events', 'reservation.created', { reservationId: 'r-2' });

    expect(assertExchange).toHaveBeenCalledOnce();
    expect(assertExchange).toHaveBeenCalledWith('domain-events', 'topic', { durable: true });
    expect(publish).toHaveBeenCalledTimes(2);
    const [, , firstContent] = publish.mock.calls[0] as [string, string, Buffer];
    expect(JSON.parse(firstContent.toString())).toEqual({ reservationId: 'r-1' });
  });

  it('throws when the channel reports backpressure', async () => {
    publish.mockReturnValueOnce(false);
    const publisher = await connectPublisher('amqp://fake');

    await expect(publisher.publish('domain-events', 'x', {})).rejects.toThrow('backpressure');
  });

  it('closes the channel then the connection', async () => {
    const publisher = await connectPublisher('amqp://fake');
    await publisher.close();

    expect(channelClose).toHaveBeenCalledOnce();
    expect(connectionClose).toHaveBeenCalledOnce();
  });
});
