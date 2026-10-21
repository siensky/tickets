/**
 * RabbitMQ connection and a minimal topic-exchange publisher
 * (docs/plan.md "Idempotens": the outbox relay publisher). Deliberately
 * generic — it knows nothing about outbox rows or event types, those
 * live in each caller (the outbox vocabulary is in `@tickets/domain`,
 * which this package may not import — docs/rules.md §1 keeps shared
 * packages independent of each other).
 */
import { connect, type Channel, type ChannelModel } from 'amqplib';

export interface RabbitPublisher {
  /** Publishes `payload` as JSON to `exchange` (asserted as a durable topic exchange on first use). */
  publish(exchange: string, routingKey: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function connectPublisher(url: string): Promise<RabbitPublisher> {
  const connection: ChannelModel = await connect(url);
  const channel: Channel = await connection.createChannel();
  const assertedExchanges = new Set<string>();

  return {
    async publish(exchange, routingKey, payload) {
      if (!assertedExchanges.has(exchange)) {
        await channel.assertExchange(exchange, 'topic', { durable: true });
        assertedExchanges.add(exchange);
      }
      const content = Buffer.from(JSON.stringify(payload));
      const accepted = channel.publish(exchange, routingKey, content, {
        contentType: 'application/json',
        persistent: true,
      });
      if (!accepted) {
        // channel.publish() returns false when amqplib's internal write
        // buffer is full (backpressure). Treated as a hard failure so
        // the outbox relay leaves the row unpublished and retries it on
        // its next poll, instead of silently dropping the event.
        throw new Error(`RabbitMQ rejected publish to exchange "${exchange}" (backpressure)`);
      }
    },
    async close() {
      await channel.close();
      await connection.close();
    },
  };
}
