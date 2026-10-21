/**
 * `events` — shard key is its own `id` (docs/plan.md "Databas"). No FK to
 * `venues`: venues live on shard-0, foreign keys don't work across
 * databases (docs/forsvar.md "Vad gör man med data som saknar
 * shard-nyckel?").
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    venue_id: { type: 'uuid', notNull: true },
    title: { type: 'text', notNull: true },
    artist: { type: 'text', notNull: true },
    starts_at: { type: 'timestamptz', notNull: true },
    sales_open_at: { type: 'timestamptz', notNull: true },
    sales_close_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true, default: 'scheduled' },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('events');
}
