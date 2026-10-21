/**
 * `idempotency_keys` — one row per (event, principal, operation)
 * attempt (docs/plan.md "Idempotens"). `scope` binds the key to the
 * calling identity (queue token or user id) so a guessed/intercepted key
 * can never replay someone else's saved response.
 *
 * `status` is the in-flight/completed state machine docs/plan.md
 * describes: the INSERT winner runs the real operation; concurrent
 * retries hit the primary key but find no saved response yet and must
 * get `IdempotencyConflictError` (409), never an empty body.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('idempotency_keys', {
    event_id: { type: 'uuid', notNull: true },
    scope: { type: 'text', notNull: true },
    key: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    response_body: { type: 'jsonb' },
    status: {
      type: 'text',
      notNull: true,
      default: 'in_flight',
      check: "status IN ('in_flight', 'completed')",
    },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('idempotency_keys', 'idempotency_keys_pkey', {
    primaryKey: ['event_id', 'scope', 'key'],
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('idempotency_keys');
}
