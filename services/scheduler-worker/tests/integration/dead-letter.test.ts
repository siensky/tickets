/**
 * Dead-letter mot en RIKTIG RabbitMQ (docs/plan.md 8.6, docs/rules.md §8): ett meddelande som överskrider
 * `x-delivery-limit` hamnar i `<kö>.dead` i stället för att försvinna. Uppsättningen är samma som i produktion:
 * köerna deklareras av `connectConsumer` och policyerna är den RIKTIGA `definitions.json` (importerad med
 * `rabbitmqctl import_definitions`, som statefulsetens postStart-hook). Policyn importeras EFTER att kön redan
 * finns, som i produktion, och en ny deklaration av kön får inte ge PRECONDITION_FAILED.
 */
import { OUTBOX_EXCHANGE } from '@tickets/domain';
import { connectConsumer, deadLetterQueueName } from '@tickets/rabbit';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import amqplib from 'amqplib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from './test-helpers.js';

const DEFINITIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/k8s/base/rabbitmq/definitions.json',
);
const QUEUE = 'booking-api.payment-succeeded';
const ROUTING_KEY = 'payment.succeeded';
const OPTIONS = {
  exchange: OUTBOX_EXCHANGE,
  queue: QUEUE,
  routingKey: ROUTING_KEY,
  deliveryLimit: 2,
};

describe('dead-letter', () => {
  let rabbitmq: StartedRabbitMQContainer;

  beforeAll(async () => {
    rabbitmq = await new RabbitMQContainer('rabbitmq:4-management-alpine').start();
  }, 180_000);

  afterAll(async () => {
    await rabbitmq.stop();
  });

  it('lägger ett giftigt meddelande i dödkön efter delivery-limit, även när kön fanns före policyn', async () => {
    // 1. Kön finns redan (som i produktion) innan policyn importeras.
    const before = await connectConsumer(
      rabbitmq.getAmqpUrl(),
      OPTIONS,
      () => Promise.resolve(),
      () => undefined,
    );
    await before.close();

    // 2. Samma importsteg som statefulsetens postStart-hook.
    await rabbitmq.copyContentToContainer([
      { content: readFileSync(DEFINITIONS, 'utf8'), target: '/tmp/definitions.json' },
    ]);
    const imported = await rabbitmq.exec([
      'rabbitmqctl',
      'import_definitions',
      '/tmp/definitions.json',
    ]);
    expect(imported.exitCode).toBe(0);
    await waitFor(
      async () => {
        const policies = await rabbitmq.exec(['rabbitmqctl', '-q', 'list_policies']);
        return policies.output.includes('dead-letter-booking-api.payment-succeeded');
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    // 3. En ny deklaration av den befintliga kön får inte kasta, och en alltid-nackande konsument ger upp.
    const attempts: string[] = [];
    const consumer = await connectConsumer(
      rabbitmq.getAmqpUrl(),
      OPTIONS,
      (payload) => {
        attempts.push(JSON.stringify(payload));
        return Promise.reject(new Error('giftigt meddelande'));
      },
      () => undefined,
    );
    const connection = await amqplib.connect(rabbitmq.getAmqpUrl());
    const channel = await connection.createChannel();
    channel.publish(
      OUTBOX_EXCHANGE,
      ROUTING_KEY,
      Buffer.from(JSON.stringify({ orderId: 'o-1' })),
      {
        persistent: true,
        messageId: 'm-1',
      },
    );

    let deadContent: string | undefined;
    let deadRoutingKey: string | undefined;
    await waitFor(
      async () => {
        const message = await channel.get(deadLetterQueueName(QUEUE), { noAck: true });
        deadContent = message === false ? undefined : message.content.toString();
        deadRoutingKey = message === false ? undefined : message.fields.routingKey;
        return deadContent !== undefined;
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );

    expect(JSON.parse(deadContent ?? 'null')).toEqual({ orderId: 'o-1' });
    expect(deadRoutingKey).toBe(QUEUE);
    // delivery-limit 2: exakt två försök, sedan dödkön.
    expect(attempts).toHaveLength(2);
    await channel.close();
    await connection.close();
    await consumer.close();
  }, 120_000);
});
