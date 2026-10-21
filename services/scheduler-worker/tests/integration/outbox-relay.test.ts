/**
 * Crown-jewel test #4 (docs/plan.md "Tester"): RabbitMQ goes down while
 * an event is waiting in the outbox → the event is still delivered once
 * RabbitMQ comes back, because the relay never marks a row published
 * until the publish actually succeeded.
 */
import { createLogger } from '@tickets/observability';
import { OUTBOX_EXCHANGE } from '@tickets/domain';
import { randomUUID } from 'node:crypto';
import amqplib, { type ChannelModel } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOutboxRelay } from '../../src/services/outbox-relay-service.js';
import {
  getOutboxPublishedAt,
  insertOutboxEvent,
  startTestInfra,
  stopTestInfra,
  waitFor,
  type TestInfra,
} from './test-helpers.js';

async function consumeOne(
  connectionUrl: string,
): Promise<{ connection: ChannelModel; received: Promise<unknown> }> {
  const connection = await amqplib.connect(connectionUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(OUTBOX_EXCHANGE, 'topic', { durable: true });
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, OUTBOX_EXCHANGE, '#');

  const received = new Promise<unknown>((resolve) => {
    void channel.consume(queue, (message) => {
      if (message !== null) {
        resolve(JSON.parse(message.content.toString()));
      }
    });
  });
  return { connection, received };
}

describe('outbox relay (crown jewel #4)', () => {
  let infra: TestInfra;

  beforeAll(async () => {
    infra = await startTestInfra();
  }, 180_000);

  afterAll(async () => {
    await stopTestInfra(infra);
  });

  it('delivers an event written while RabbitMQ was down, once it comes back', async () => {
    const eventId = randomUUID();
    const payload = { reservationId: randomUUID(), eventId };
    const outboxId = await insertOutboxEvent(infra, {
      eventId,
      type: 'reservation.created',
      payload,
    });

    const amqpUrl = infra.rabbitmq.getAmqpUrl();
    await infra.rabbitmq.stop();

    const logger = createLogger({ serviceName: 'test' });
    const relay = startOutboxRelay(infra.shardPools, amqpUrl, logger, 200);

    // A couple of ticks while RabbitMQ is down: must not mark it published.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await getOutboxPublishedAt(infra, outboxId)).toBeNull();

    await infra.rabbitmq.restart();
    const { connection, received } = await consumeOne(amqpUrl);

    await waitFor(async () => (await getOutboxPublishedAt(infra, outboxId)) !== null, {
      timeoutMs: 30_000,
      intervalMs: 300,
    });
    await expect(received).resolves.toEqual(payload);

    await relay.stop();
    await connection.close();
  }, 120_000);
});
