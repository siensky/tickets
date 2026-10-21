/**
 * Crown-jewel test #4 (docs/plan.md "Tester"): RabbitMQ goes down while
 * an event is waiting in the outbox → the event is still delivered once
 * RabbitMQ comes back, because the relay never marks a row published
 * until the publish actually succeeded.
 *
 * The consumer's queue is declared DURABLE and NAMED, and set up
 * BEFORE RabbitMQ goes down — an exclusive/anonymous queue (or one
 * declared only after the outage) doesn't survive the broker restart,
 * and racing its declaration against the relay's own retry loop after
 * the restart is exactly the kind of flake this test must not have.
 * A durable queue+binding declared up front is already sitting there
 * (RabbitMQ persists durable topology across a restart of the same
 * container) by the time the relay's publish succeeds, so the message
 * is routed into it regardless of when a consumer actually reads it.
 *
 * The container's mapped host PORT, unlike its topology, does NOT
 * survive the restart (verified empirically against this Docker
 * setup) — `getAmqpUrl()` is re-read afterward, never reused from
 * before the outage.
 */
import { createLogger } from '@tickets/observability';
import { OUTBOX_EXCHANGE } from '@tickets/domain';
import { randomUUID } from 'node:crypto';
import amqplib, { type Channel } from 'amqplib';
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

const TEST_QUEUE = 'fas2-outbox-relay-test-queue';

async function declareDurableTestQueue(connectionUrl: string): Promise<void> {
  const connection = await amqplib.connect(connectionUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(OUTBOX_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(TEST_QUEUE, { durable: true });
  await channel.bindQueue(TEST_QUEUE, OUTBOX_EXCHANGE, '#');
  await channel.close();
  await connection.close();
}

async function consumeFromTestQueue(connectionUrl: string): Promise<{
  channel: Channel;
  received: Promise<{ body: unknown; messageId: string | undefined }>;
}> {
  const connection = await amqplib.connect(connectionUrl);
  const channel = await connection.createChannel();
  const received = new Promise<{ body: unknown; messageId: string | undefined }>((resolve) => {
    void channel.consume(TEST_QUEUE, (message) => {
      if (message !== null) {
        // amqplib types `properties.messageId` as `any` — it's always
        // a string here since that's all this relay ever sets.
        const messageId = message.properties.messageId as string | undefined;
        resolve({ body: JSON.parse(message.content.toString()), messageId });
      }
    });
  });
  return { channel, received };
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
    const amqpUrl = infra.rabbitmq.getAmqpUrl();
    await declareDurableTestQueue(amqpUrl);

    const eventId = randomUUID();
    const payload = { reservationId: randomUUID(), eventId };
    const outboxId = await insertOutboxEvent(infra, {
      eventId,
      type: 'reservation.created',
      payload,
    });

    // `remove: false` — testcontainers' default `stop()` also REMOVES
    // the container, so a later `restart()` would fail with "no such
    // container". This needs the container to still exist, just
    // stopped, so it can come back up as the SAME container with the
    // same durable topology — but NOT the same port mapping: verified
    // empirically that this Docker setup hands the restarted container
    // a NEW random host port, so `getAmqpUrl()` has to be re-read after
    // the restart, never reused from before the outage.
    await infra.rabbitmq.stop({ remove: false });

    const logger = createLogger({ serviceName: 'test' });
    let relay = startOutboxRelay(infra.shardPools, amqpUrl, logger, 200);

    // While RabbitMQ is down, the relay must keep failing to publish —
    // waiting FOR that (and expecting the wait to time out) instead of
    // sleeping a fixed amount, then checking once (docs/rules.md §8:
    // no sleep, wait for a condition).
    await expect(
      waitFor(async () => (await getOutboxPublishedAt(infra, outboxId)) !== null, {
        timeoutMs: 2000,
        intervalMs: 200,
      }),
    ).rejects.toThrow();

    await infra.rabbitmq.restart();
    const amqpUrlAfterRestart = infra.rabbitmq.getAmqpUrl();

    // The old relay is stuck on the pre-outage (now wrong) port and can
    // never recover on its own — a real deployment doesn't have this
    // problem (a Kubernetes Service keeps one stable DNS name/port
    // regardless of which pod backs it), so this is purely a
    // test-environment accommodation, not a production behavior to add.
    await relay.stop();
    relay = startOutboxRelay(infra.shardPools, amqpUrlAfterRestart, logger, 200);

    await waitFor(async () => (await getOutboxPublishedAt(infra, outboxId)) !== null, {
      timeoutMs: 30_000,
      intervalMs: 300,
    });

    const { channel, received } = await consumeFromTestQueue(amqpUrlAfterRestart);
    const message = await received;
    expect(message.body).toEqual(payload);
    expect(message.messageId).toBe(outboxId);

    await relay.stop();
    await channel.close();
  }, 180_000);
});
