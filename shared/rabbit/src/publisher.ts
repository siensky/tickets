/**
 * RabbitMQ connection and a minimal topic-exchange publisher
 * (docs/plan.md "Idempotens": the outbox relay publisher). Deliberately
 * generic — it knows nothing about outbox rows or event types, those
 * live in each caller (the outbox vocabulary is in `@tickets/domain`,
 * which this package may not import — docs/rules.md §1 keeps shared
 * packages independent of each other).
 *
 * Uses a CONFIRM channel: `publish()` only resolves once the BROKER has
 * acknowledged the message, not just once it's buffered locally. A
 * plain (non-confirm) channel's `publish()` returning `true` means
 * nothing more than "accepted into amqplib's local write buffer" — the
 * message could still be lost between here and the broker (a dropped
 * TCP connection, say) with no way to know. The relay that calls this
 * only marks an outbox row published after `publish()` resolves, so
 * that guarantee has to be real.
 *
 * This guarantees the broker accepted the message — it does NOT and
 * cannot guarantee a consumer received it. In a topic exchange with no
 * queue bound, the broker still accepts and then silently drops the
 * message; that's standard pub/sub, and declaring queues on behalf of
 * future consumers isn't this publisher's job (consumers bind their
 * own queues to the exchange when they exist).
 */
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';

export interface PublishOptions {
  /** Set as the AMQP message-id property — what a consumer dedupes on (docs/plan.md "Idempotens"). */
  messageId?: string;
}

export interface RabbitPublisher {
  publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options?: PublishOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export async function connectPublisher(url: string): Promise<RabbitPublisher> {
  const connection: ChannelModel = await connect(url);
  const channel: ConfirmChannel = await connection.createConfirmChannel();
  const assertedExchanges = new Set<string>();

  return {
    async publish(exchange, routingKey, payload, options) {
      if (!assertedExchanges.has(exchange)) {
        await channel.assertExchange(exchange, 'topic', { durable: true });
        assertedExchanges.add(exchange);
      }
      const content = Buffer.from(JSON.stringify(payload));
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          exchange,
          routingKey,
          content,
          { contentType: 'application/json', persistent: true, messageId: options?.messageId },
          (error) => {
            if (error) {
              reject(
                new Error(
                  `RabbitMQ did not confirm publish to exchange "${exchange}": ${String(error)}`,
                ),
              );
            } else {
              resolve();
            }
          },
        );
      });
    },
    async close() {
      await channel.close();
      await connection.close();
    },
  };
}
