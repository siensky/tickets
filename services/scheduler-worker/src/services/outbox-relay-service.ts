/**
 * The outbox relay (docs/plan.md "Idempotens": "Relayn bor i
 * scheduler-worker, pollar båda shardarna"). Publishing happens INSIDE
 * the same transaction that marks rows published — if RabbitMQ is down,
 * the publish throws, the transaction rolls back, and the rows stay
 * unpublished for the next tick to retry (crown-jewel outbox test).
 *
 * The connection is lazy and self-healing: on any failure the cached
 * publisher is closed and dropped, so the next tick reconnects from
 * scratch instead of retrying forever against a channel that's already
 * dead. Each outbox row's own id is sent as the AMQP `messageId`
 * property — without a stable id on the wire, a consumer has nothing
 * to key its own dedupe on (`processed_messages` exists specifically
 * for this, docs/plan.md "Idempotens"), and a crash between publishing
 * a batch and committing `published_at` would republish the whole
 * batch with no way for anyone downstream to tell.
 */
import { withTransaction, type ShardPools } from '@tickets/db';
import { OUTBOX_EXCHANGE } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import { connectPublisher, type RabbitPublisher } from '@tickets/rabbit';
import type { Pool } from 'pg';
import {
  claimUnpublishedOutboxEvents,
  markOutboxEventsPublished,
} from '../repositories/outbox-repository.js';

const BATCH_SIZE = 100;

async function relayBatchForPool(pool: Pool, publisher: RabbitPublisher): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await claimUnpublishedOutboxEvents(client, BATCH_SIZE);
    for (const event of events) {
      await publisher.publish(OUTBOX_EXCHANGE, event.type, event.payload, {
        messageId: event.id,
      });
    }
    await markOutboxEventsPublished(
      client,
      events.map((event) => event.id),
    );
  });
}

export interface OutboxRelay {
  /** Stops future ticks, waits for any tick already in flight, then closes the RabbitMQ connection. */
  stop(): Promise<void>;
}

export function startOutboxRelay(
  shardPools: ShardPools,
  rabbitUrl: string,
  logger: Logger,
  intervalMs = 1000,
): OutboxRelay {
  let publisher: RabbitPublisher | null = null;
  let tickInFlight: Promise<void> | null = null;

  const getPublisher = async (): Promise<RabbitPublisher> => {
    publisher ??= await connectPublisher(rabbitUrl);
    return publisher;
  };

  const runTick = async (): Promise<void> => {
    for (const pool of shardPools.pools) {
      try {
        await relayBatchForPool(pool, await getPublisher());
      } catch (error) {
        logger.warn(
          { error },
          'outbox relay batch failed, will reconnect and retry next tick',
        );
        // Close the now-possibly-dead connection before dropping the
        // reference — otherwise every failure leaks one RabbitMQ
        // connection, and a slow tick racing a reconnect from a
        // DIFFERENT failed tick could leak a second one on top.
        const dead = publisher;
        publisher = null;
        await dead?.close().catch(() => undefined);
      }
    }
  };

  const timer = setInterval(() => {
    // An overlap guard, not just a leak/race fix: without it, a slow
    // tick (Postgres or RabbitMQ under load) can still be running when
    // the next one fires, so two ticks race to lazily reconnect and
    // each closes/nulls the OTHER's publisher mid-flight.
    if (tickInFlight !== null) {
      return;
    }
    tickInFlight = runTick().finally(() => {
      tickInFlight = null;
    });
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      // Graceful shutdown (docs/plan.md "Zero-downtime") means letting
      // in-flight work finish before tearing down connections — not
      // just stopping the timer that schedules FUTURE work.
      await tickInFlight;
      await publisher?.close();
    },
  };
}
