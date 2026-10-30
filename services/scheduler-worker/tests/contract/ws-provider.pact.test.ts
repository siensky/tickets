/**
 * Pact-providerverifiering av scheduler-workers `ws:*`-meddelanden till
 * realtime-gateway (docs/plan.md 7.9, kontrakt 4). Meddelandena skapas av det
 * RIKTIGA insläppsjobbet (`startQueueAdmissionJob`) mot en riktig Postgres och
 * Redis, och läses från Redis-kanalen precis som gatewayen ser dem.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Verifier } from '@pact-foundation/pact';
import { createBusinessMetrics, createLogger, createRegistry } from '@tickets/observability';
import { joinWaitingRoom, subscribeToChannel, wsChannel } from '@tickets/redis';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startQueueAdmissionJob } from '../../src/services/queue-admission-service.js';
import {
  seedEvent,
  startTestInfra,
  startTestRedis,
  stopTestInfra,
  stopTestRedis,
  type TestInfra,
  type TestRedis,
} from '../integration/test-helpers.js';

const PACT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../pacts/realtime-gateway-scheduler-worker.json',
);

describe('scheduler-worker message provider verification', () => {
  let infra: TestInfra;
  let redis: TestRedis;

  beforeAll(async () => {
    if (!existsSync(PACT_FILE)) {
      throw new Error(
        `${PACT_FILE} is missing. Run the consumer pact tests first (pnpm test:contract).`,
      );
    }
    [infra, redis] = await Promise.all([startTestInfra(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestInfra(infra), stopTestRedis(redis)]);
  });

  /** Ställer en kötoken i kön för ett event med givet försäljningsfönster och ger första ws-meddelandet. */
  async function firstMessageFor(
    salesOpenOffsetMs: number,
    salesCloseOffsetMs: number,
  ): Promise<never> {
    const eventId = randomUUID();
    const queueTokenId = randomUUID();
    await seedEvent(infra, {
      eventId,
      salesOpenAt: new Date(Date.now() + salesOpenOffsetMs),
      salesCloseAt: new Date(Date.now() + salesCloseOffsetMs),
    });
    await joinWaitingRoom(redis.client, eventId, queueTokenId);
    let resolveMessage: (payload: unknown) => void = () => undefined;
    const received = new Promise<unknown>((resolve) => {
      resolveMessage = resolve;
    });
    const subscription = await subscribeToChannel(
      redis.client,
      wsChannel(queueTokenId),
      resolveMessage,
    );
    const job = startQueueAdmissionJob(
      infra.shardPools,
      redis.client,
      createLogger({ serviceName: 'contract' }),
      createBusinessMetrics(createRegistry('contract')),
      200,
    );
    try {
      return (await received) as never;
    } finally {
      await job.stop();
      await subscription.unsubscribe();
    }
  }

  it('uppfyller kontraktet för admitted och sales_closed', async () => {
    const noState = (): Promise<void> => Promise.resolve();
    await new Verifier({
      provider: 'scheduler-worker',
      pactUrls: [PACT_FILE],
      stateHandlers: {
        'a queue token was admitted': noState,
        'the sales window closed while a queue token was waiting': noState,
      },
      messageProviders: {
        'an admitted message': () => firstMessageFor(-60_000, 60_000),
        'a sales_closed message': () => firstMessageFor(-120_000, -60_000),
      },
      logLevel: 'warn',
    }).verifyProvider();
  }, 60_000);
});
