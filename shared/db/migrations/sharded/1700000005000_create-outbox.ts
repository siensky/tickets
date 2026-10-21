/**
 * `outbox` — transactional outbox (docs/plan.md "Idempotens"). A row is
 * inserted in the SAME transaction as the business write it announces,
 * so the event can never go missing even if RabbitMQ is down at the
 * time. `scheduler-worker`'s relay (the only singleton service) polls
 * `published_at IS NULL` with `FOR UPDATE SKIP LOCKED` across both
 * shards and publishes it later.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('outbox', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    published_at: { type: 'timestamptz' },
  });

  pgm.createIndex('outbox', 'created_at', { where: 'published_at IS NULL' });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('outbox');
}
