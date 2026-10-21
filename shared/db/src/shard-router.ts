/**
 * Deterministic event_id → shard index mapping (docs/plan.md "Databas":
 * "Shard-nyckel event_id... Routinglager hashar"). Pure function so the
 * distribution is trivially unit-testable without a database.
 *
 * md5 (not a cryptographic choice here, just a stable, well-distributed
 * hash) keeps this deterministic across processes and restarts — two
 * pods must always agree on which shard a given event_id belongs to.
 */
import { createHash } from 'node:crypto';

export function hashEventIdToShardIndex(eventId: string, shardCount: number): number {
  if (shardCount < 1) {
    throw new RangeError('shardCount must be at least 1');
  }
  const digest = createHash('md5').update(eventId).digest();
  const firstFourBytes = digest.readUInt32BE(0);
  return firstFourBytes % shardCount;
}
