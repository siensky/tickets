/**
 * `tickets` — the QR-scannable proof of purchase (docs/plan.md
 * "Databas"). The partial unique index on `(event_id, seat_id)` is
 * scoped to `status = 'valid'`: a refunded ticket must stop blocking
 * resale of its seat while the oversell guarantee stays intact for
 * every ticket that's still valid.
 *
 * Fas 2 only creates the table; tickets are issued once the Fas 3
 * payment flow exists.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('tickets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    order_id: { type: 'uuid', notNull: true, references: 'orders', onDelete: 'CASCADE' },
    seat_id: { type: 'uuid', notNull: true, references: 'seats' },
    qr_token: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'valid',
      check: "status IN ('valid', 'refunded', 'void')",
    },
    scanned_at: { type: 'timestamptz' },
    scanned_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('tickets', 'order_id');
  pgm.createIndex('tickets', ['event_id', 'seat_id'], {
    unique: true,
    where: "status = 'valid'",
    name: 'tickets_valid_seat_unique',
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('tickets');
}
