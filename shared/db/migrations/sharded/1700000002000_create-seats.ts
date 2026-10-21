/**
 * `seats` — the row the reservation transaction locks (docs/plan.md
 * "Concurrency-kärnan"). `ticket_number` is the CSV-supplied ticket
 * number (docs/plan.md "Import av biljettnummer (CSV)") — the column
 * belongs to the schema from day one even though the one-off import
 * script lands later, closer to when a real event's CSV exists.
 *
 * `reservation_id` has no FK, same reasoning as `orders.reservation_id`
 * (docs/plan.md "Databas"): keeps the relation a plain pointer so it
 * never blocks a future cleanup job, and stays consistent with how the
 * rest of the schema treats soft references.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('seats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    venue_seat_id: { type: 'uuid', notNull: true },
    section_id: { type: 'uuid', notNull: true },
    row: { type: 'text', notNull: true },
    number: { type: 'integer', notNull: true },
    ticket_number: { type: 'text', notNull: true },
    price_cents: { type: 'integer', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'available',
      check: "status IN ('available', 'held', 'sold')",
    },
    reservation_id: { type: 'uuid' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('seats', 'event_id');
  pgm.createIndex('seats', ['event_id', 'section_id', 'row', 'number'], { unique: true });
  pgm.createIndex('seats', ['event_id', 'ticket_number'], { unique: true });
  pgm.createIndex('seats', 'reservation_id', { where: 'reservation_id IS NOT NULL' });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('seats');
}
