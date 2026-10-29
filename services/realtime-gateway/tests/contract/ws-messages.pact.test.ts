/**
 * Pact-konsumenttest (message pact): booking-api och scheduler-worker →
 * realtime-gateway över Redis `ws:*` (docs/plan.md 7.9, kontrakt 4). Meddelandena
 * går genom den RIKTIGA `startWsSubscriberRegistry` mot en riktig Redis. Gatewayen
 * vidarebefordrar JSON-kroppen oförändrad till klientens socket, så kontraktet är
 * kroppens form. Skriver `pacts/realtime-gateway-booking-api.json` och
 * `pacts/realtime-gateway-scheduler-worker.json`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matchers, PactV4 } from '@pact-foundation/pact';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  closeRedisClient,
  createRedisClient,
  publishToChannel,
  wsChannel,
} from '@tickets/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWsSubscriberRegistry } from '../../src/services/ws-subscriber-registry.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const WS_CLIENT_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f';
const SEAT_ID = '44444444-4444-4444-8444-444444444444';

let container: StartedRedisContainer;

beforeAll(async () => {
  container = await new RedisContainer('redis:8-alpine').start();
}, 180_000);

afterAll(async () => {
  await container.stop();
});

/** Matar meddelandet via Redis in genom registryt och ger tillbaka vad klientens handler fick. */
async function deliver(contents: unknown): Promise<unknown> {
  const subscriberClient = createRedisClient(container.getConnectionUrl());
  const publisherClient = createRedisClient(container.getConnectionUrl());
  const registry = await startWsSubscriberRegistry(subscriberClient);
  try {
    const received = new Promise<unknown>((resolveMessage) => {
      registry.register(WS_CLIENT_ID, resolveMessage);
    });
    await publishToChannel(publisherClient, wsChannel(WS_CLIENT_ID), contents);
    return await received;
  } finally {
    await registry.close();
    await closeRedisClient(subscriberClient);
    await closeRedisClient(publisherClient);
  }
}

function pactFor(provider: string): PactV4 {
  return new PactV4({
    consumer: 'realtime-gateway',
    provider,
    dir: PACTS_DIR,
    logLevel: 'warn',
  });
}

describe('→ realtime-gateway', () => {
  it('booking-api: seat_taken når klientens socket', async () => {
    await pactFor('booking-api')
      .addAsynchronousInteraction()
      .given('another queue token holds a mark on a seat that was just reserved')
      .expectsToReceive('a seat_taken message', (builder) => {
        builder.withJSONContent({ type: 'seat_taken', seatId: Matchers.uuid(SEAT_ID) });
      })
      .executeTest(async (message) => {
        const contents: unknown = JSON.parse(JSON.stringify(message.contents.content));
        expect(await deliver(contents)).toEqual(contents);
      });
  });

  it('scheduler-worker: admitted och sales_closed når klientens socket', async () => {
    const pact = pactFor('scheduler-worker');
    await pact
      .addAsynchronousInteraction()
      .given('a queue token was admitted')
      .expectsToReceive('an admitted message', (builder) => {
        builder.withJSONContent({ type: 'admitted' });
      })
      .executeTest(async (message) => {
        expect(await deliver(message.contents.content)).toEqual({ type: 'admitted' });
      });
    await pact
      .addAsynchronousInteraction()
      .given('the sales window closed while a queue token was waiting')
      .expectsToReceive('a sales_closed message', (builder) => {
        builder.withJSONContent({ type: 'sales_closed' });
      })
      .executeTest(async (message) => {
        expect(await deliver(message.contents.content)).toEqual({ type: 'sales_closed' });
      });
  });
});
