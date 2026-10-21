/**
 * `config` — key/value settings the system reads live instead of
 * hardcoding (docs/plan.md "Databas": "config styr: ... max
 * stolar/bokning"). Global, shard-0 only.
 *
 * Seeds only the three keys Fas 2 reads (hold time, release jitter, max
 * seats per booking). Fas 3 adds the waiting-room keys (admission rate,
 * session length) in their own migration, when that code lands —
 * forward-compatible per docs/rules.md §4.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('config', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
  });

  pgm.sql(`
    INSERT INTO config (key, value) VALUES
      ('reservation_hold_minutes', '5'),
      ('reservation_release_jitter_max_seconds', '20'),
      ('max_seats_per_reservation', '5');
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('config');
}
