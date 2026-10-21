/**
 * `reservations` — the all-or-nothing 5-minute hold (docs/plan.md
 * "Concurrency-kärnan"). The partial unique index is what enforces "en
 * aktiv reservation per kötoken" at the database, not in application
 * code — it must survive even if the service layer has a bug.
 *
 * `release_after` (not `expires_at`) is what the lazy-expiry check and
 * scheduler-worker's release job compare against — comparing against
 * `expires_at` would make the 0–20s release jitter meaningless (plan.md
 * "Concurrency-kärnan").
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('reservations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    queue_token_id: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('active', 'pending_payment', 'converted', 'expired', 'cancelled')",
    },
    expires_at: { type: 'timestamptz', notNull: true },
    release_after: { type: 'timestamptz', notNull: true },
    payment_frozen_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('reservations', 'event_id');
  pgm.createIndex('reservations', 'release_after', { where: "status = 'active'" });
  pgm.createIndex('reservations', 'queue_token_id', {
    unique: true,
    where: "status = 'active'",
    name: 'reservations_active_queue_token_unique',
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('reservations');
}
