/**
 * All SQL for the outbox relay (docs/plan.md "Idempotens"). `FOR UPDATE
 * SKIP LOCKED` is what lets this run safely even though scheduler-worker
 * is a singleton that could in principle be restarted mid-batch — a
 * second pass just skips whatever a still-committing transaction holds,
 * instead of blocking on it.
 */
import type { PoolClient } from 'pg';

export interface OutboxEventRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

export async function claimUnpublishedOutboxEvents(
  client: PoolClient,
  limit: number,
): Promise<OutboxEventRow[]> {
  const { rows } = await client.query<{ id: string; type: string; payload: unknown }>(
    `SELECT id, type, payload
     FROM outbox
     WHERE published_at IS NULL
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markOutboxEventsPublished(
  client: PoolClient,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [ids]);
}
