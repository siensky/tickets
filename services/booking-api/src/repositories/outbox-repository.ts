/**
 * Writes to the transactional outbox (docs/plan.md "Idempotens"). Always
 * called with the SAME transaction client as the business write it
 * announces — that's what makes the outbox pattern work: the event can
 * never go missing even if RabbitMQ is down when this runs.
 */
import type { OutboxEventType } from '@tickets/domain';
import type { PoolClient } from 'pg';

export async function insertOutboxEvent(
  client: PoolClient,
  params: { eventId: string; type: OutboxEventType; payload: unknown },
): Promise<void> {
  await client.query('INSERT INTO outbox (event_id, type, payload) VALUES ($1, $2, $3)', [
    params.eventId,
    params.type,
    JSON.stringify(params.payload),
  ]);
}
