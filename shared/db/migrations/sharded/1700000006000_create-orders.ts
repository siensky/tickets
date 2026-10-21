/**
 * `orders` — created once a reservation converts to a paid purchase
 * (docs/plan.md "Databas"). `user_id` is a plain UUID with no FK: users
 * live on shard-0, foreign keys don't work across databases. Likewise
 * `reservation_id` has no FK by design — see docs/plan.md "Databas":
 * reservations and orders share a shard so an FK *would* work, but it
 * would make the nightly 30-day reservation cleanup fail silently.
 *
 * Fas 2 only creates the table (schema completeness per "Schema +
 * migrations mot båda shardarna"); the order-creation flow itself is
 * built in Fas 3 alongside Stripe/payment-mock.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    user_id: { type: 'uuid', notNull: true },
    reservation_id: { type: 'uuid' },
    total_cents: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('orders', 'event_id');
  pgm.createIndex('orders', 'user_id');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('orders');
}
