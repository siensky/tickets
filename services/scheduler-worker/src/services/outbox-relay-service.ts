/**
 * The outbox relay (docs/plan.md "Idempotens": "Relayn bor i
 * scheduler-worker, pollar båda shardarna"). Publishing happens INSIDE
 * the same transaction that marks rows published — if RabbitMQ is down,
 * the publish throws, the transaction rolls back, and the rows stay
 * unpublished for the next tick to retry.
 *
 * The connection is lazy and self-healing: on any failure the cached
 * publisher is dropped, so the next tick reconnects from scratch
 * instead of retrying forever against a channel that's already dead
 * (crown-jewel outbox test: RabbitMQ goes down mid-sale, comes back,
 * the queued event still gets delivered).
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
      await publisher.publish(OUTBOX_EXCHANGE, event.type, event.payload);
    }
    await markOutboxEventsPublished(
      client,
      events.map((event) => event.id),
    );
  });
}

export interface OutboxRelay {
  stop(): Promise<void>;
}

export function startOutboxRelay(
  shardPools: ShardPools,
  rabbitUrl: string,
  logger: Logger,
  intervalMs = 1000,
): OutboxRelay {
  let publisher: RabbitPublisher | null = null;

  const getPublisher = async (): Promise<RabbitPublisher> => {
    publisher ??= await connectPublisher(rabbitUrl);
    return publisher;
  };

  const timer = setInterval(() => {
    void (async () => {
      for (const pool of shardPools.pools) {
        try {
          await relayBatchForPool(pool, await getPublisher());
        } catch (error) {
          logger.warn(
            { error },
            'outbox relay batch failed, will reconnect and retry next tick',
          );
          publisher = null;
        }
      }
    })();
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await publisher?.close();
    },
  };
}
