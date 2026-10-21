/**
 * `venues`, `venue_sections`, `venue_seats` — the static arena map
 * (docs/plan.md "Databas"). Global, shard-0 only: a venue's geometry is
 * shared across every event, so it cannot be duplicated per shard.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('venues', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    city: { type: 'text', notNull: true },
  });

  pgm.createTable('venue_sections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    venue_id: { type: 'uuid', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    display_order: { type: 'integer', notNull: true },
  });
  pgm.createIndex('venue_sections', 'venue_id');

  pgm.createTable('venue_seats', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    venue_id: { type: 'uuid', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    section_id: {
      type: 'uuid',
      notNull: true,
      references: 'venue_sections',
      onDelete: 'CASCADE',
    },
    row: { type: 'text', notNull: true },
    number: { type: 'integer', notNull: true },
    x: { type: 'numeric', notNull: true },
    y: { type: 'numeric', notNull: true },
  });
  pgm.createIndex('venue_seats', 'section_id');
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('venue_seats');
  pgm.dropTable('venue_sections');
  pgm.dropTable('venues');
}
