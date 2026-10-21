/**
 * All SQL for the idempotency-key claim/complete state machine
 * (docs/plan.md "Idempotens"). `scope` binds the key to the calling
 * identity so a guessed/intercepted key can't replay someone else's
 * saved response; `(event_id, scope, key)` is the table's primary key.
 *
 * Every function here takes the `Pool`, not a transaction `client`, and
 * runs as its own single auto-committed statement — deliberately
 * OUTSIDE the main reservation transaction. That's what makes a
 * concurrent caller's claim attempt actually observe `in_flight`: if the
 * claim lived inside the same transaction as the real work, a losing
 * INSERT would block on the winner's uncommitted row and only ever see
 * it after the winner's transaction already committed, so it could
 * never observe anything but `completed` — the 409-while-in-progress
 * crown-jewel behaviour (docs/plan.md "Tester") would be unreachable.
 */
import type { Pool } from 'pg';
import type { IdempotencyClaim, IdempotencyClaimParams } from '../types/idempotency.js';

/**
 * Tries to become the one caller that executes the operation.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE expires_at < now()` folds the
 * "is the existing key stale?" check into the same atomic statement as
 * the claim attempt: a fresh (not-yet-expired) existing row makes the
 * `WHERE` false, so the DO UPDATE is skipped and this returns 0 rows
 * exactly like a plain DO NOTHING would. An EXPIRED existing row makes
 * the `WHERE` true, so we overwrite it and reclaim the key — without
 * this, a key could never be reused after `expires_at` passed, and
 * (the actual bug) nothing ever checked `expires_at` at all, so a
 * stale `completed` row would go on being replayed as a valid result
 * forever.
 */
export async function claimIdempotencyKey(
  pool: Pool,
  params: IdempotencyClaimParams,
): Promise<IdempotencyClaim> {
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (event_id, scope, key, request_hash, status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, 'in_flight', NULL, now() + ($5 * interval '1 millisecond'))
     ON CONFLICT (event_id, scope, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           status = EXCLUDED.status,
           response_body = EXCLUDED.response_body,
           expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.expires_at < now()
     RETURNING event_id`,
    [params.eventId, params.scope, params.key, params.requestHash, params.ttlMs],
  );
  if (inserted.rows.length === 1) {
    return { kind: 'claimed' };
  }

  const existing = await pool.query<{
    request_hash: string;
    status: string;
    response_body: unknown;
  }>(
    `SELECT request_hash, status, response_body
     FROM idempotency_keys
     WHERE event_id = $1 AND scope = $2 AND key = $3`,
    [params.eventId, params.scope, params.key],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // Lost the race, then the winner's row vanished (deleted after its
    // own attempt failed, see deleteIdempotencyKey) before we could
    // read it. Safe to treat as if we'd won: nothing else holds the
    // key now.
    return claimIdempotencyKey(pool, params);
  }
  if (row.request_hash !== params.requestHash) {
    return { kind: 'hash_mismatch' };
  }
  if (row.status === 'in_flight') {
    return { kind: 'in_flight' };
  }
  return { kind: 'completed', responseBody: row.response_body };
}

export async function completeIdempotencyKey(
  pool: Pool,
  params: { eventId: string; scope: string; key: string; responseBody: unknown },
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_body = $4
     WHERE event_id = $1 AND scope = $2 AND key = $3`,
    [params.eventId, params.scope, params.key, JSON.stringify(params.responseBody)],
  );
}

/**
 * Undoes a claim after the real work failed, so the same key can be
 * retried fresh (seat availability changes over time — unlike a
 * payment charge, replaying a stale failure isn't the correct
 * idempotency behaviour here; only successes get memoized). Must never
 * be called once the real work has actually committed — see
 * reservation-service.ts for why.
 */
export async function deleteIdempotencyKey(
  pool: Pool,
  params: { eventId: string; scope: string; key: string },
): Promise<void> {
  await pool.query(
    'DELETE FROM idempotency_keys WHERE event_id = $1 AND scope = $2 AND key = $3',
    [params.eventId, params.scope, params.key],
  );
}
