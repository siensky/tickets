/**
 * `waitlist` — contacts offered a spot once an event is sold out
 * (docs/plan.md "Väntrum": "Slutsålt: ... konvertera kön till
 * väntelista"). Populated starting Fas 3 when the waiting room exists;
 * the table is created now for schema completeness.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('waitlist', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    contact: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('waitlist', 'event_id');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('waitlist');
}
