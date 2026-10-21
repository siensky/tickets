/**
 * `users` — global table, shard-0 only (docs/plan.md "Databas": global
 * tables live on shard-0). Lives in migrations/global so
 * scripts/migrate-all-shards.sh never runs this against shard-1.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    auth0_sub: { type: 'text', notNull: true, unique: true },
    email: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('users');
}
