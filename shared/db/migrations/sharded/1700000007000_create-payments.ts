/**
 * `payments` — one row per provider charge attempt (docs/plan.md
 * "Databas"). `order_id` gets a real FK: orders and payments always
 * share a shard, and unlike `orders.reservation_id` there's no cleanup
 * job that needs to outlive the parent row.
 *
 * Fas 2 only creates the table; the Stripe/payment-mock integration that
 * writes to it lands in Fas 3.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    order_id: { type: 'uuid', notNull: true, references: 'orders', onDelete: 'CASCADE' },
    provider: { type: 'text', notNull: true },
    provider_ref: { type: 'text', notNull: true },
    idempotency_key: { type: 'text', notNull: true },
    amount_cents: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    raw_response: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('payments', 'event_id');
  pgm.createIndex('payments', 'order_id');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('payments');
}
