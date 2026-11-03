/**
 * Rensningen av gamla reservationer mot en RIKTIG Postgres (docs/plan.md "Databas", docs/rules.md §8).
 * En container spelar båda shardarna (se test-helpers.ts).
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@tickets/observability';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runReservationRetention } from '../../src/services/reservation-retention-service.js';
import { startTestInfra, stopTestInfra, type TestInfra } from './test-helpers.js';

describe('reservation retention', () => {
  let infra: TestInfra;
  const eventId = randomUUID();
  const logger = createLogger({ serviceName: 'test' });

  beforeAll(async () => {
    infra = await startTestInfra();
  }, 180_000);

  afterEach(async () => {
    await infra.shardPools.pools[0].query('DELETE FROM reservations WHERE event_id = $1', [
      eventId,
    ]);
  });

  afterAll(async () => {
    await stopTestInfra(infra);
  });

  async function insertReservation(status: string, ageDays: number): Promise<string> {
    const { rows } = await infra.shardPools.pools[0].query<{ id: string }>(
      `INSERT INTO reservations
         (event_id, queue_token_id, status, expires_at, release_after, created_at)
       VALUES ($1, $2, $3, now() - interval '1 hour', now() - interval '1 hour',
               now() - ($4 * interval '1 day'))
       RETURNING id`,
      [eventId, randomUUID(), status, ageDays],
    );
    return rows[0]?.id ?? '';
  }

  async function remainingIds(): Promise<string[]> {
    const { rows } = await infra.shardPools.pools[0].query<{ id: string }>(
      'SELECT id FROM reservations WHERE event_id = $1',
      [eventId],
    );
    return rows.map((row) => row.id);
  }

  it('deletes finished reservations older than 30 days and keeps everything else', async () => {
    const oldExpired = await insertReservation('expired', 31);
    const oldConverted = await insertReservation('converted', 45);
    const oldCancelled = await insertReservation('cancelled', 60);
    const recentExpired = await insertReservation('expired', 29);
    // Pågående köp rörs aldrig, hur gamla de än ser ut.
    const oldActive = await insertReservation('active', 90);
    const oldPendingPayment = await insertReservation('pending_payment', 90);

    const deleted = await runReservationRetention(infra.shardPools, logger);

    expect(deleted).toBeGreaterThanOrEqual(3);
    const remaining = await remainingIds();
    expect(remaining).not.toContain(oldExpired);
    expect(remaining).not.toContain(oldConverted);
    expect(remaining).not.toContain(oldCancelled);
    expect(remaining).toEqual(
      expect.arrayContaining([recentExpired, oldActive, oldPendingPayment]),
    );
  });

  it('works through more rows than fit in one batch and is safe to run again', async () => {
    await infra.shardPools.pools[0].query(
      `INSERT INTO reservations
         (event_id, queue_token_id, status, expires_at, release_after, created_at)
       SELECT $1, gen_random_uuid()::text, 'expired', now(), now(), now() - interval '40 days'
       FROM generate_series(1, 2500)`,
      [eventId],
    );

    await runReservationRetention(infra.shardPools, logger);
    expect(await remainingIds()).toHaveLength(0);

    // Idempotent: en andra körning hittar inget och ändrar inget.
    expect(await runReservationRetention(infra.shardPools, logger)).toBe(0);
  });
});
