/**
 * `processed_messages` — consumer-side dedupe for money/ticket-critical
 * RabbitMQ messages (docs/plan.md "Idempotens": "Pengar och biljetter →
 * processed_messages-tabell med unique-constraint"). Lower-stakes
 * dedupe (notifications) uses a Redis set with TTL instead — this table
 * is reserved for the consumers that can't tolerate a false negative.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('processed_messages', {
    event_id: { type: 'uuid', notNull: true },
    message_id: { type: 'text', notNull: true },
    consumer: { type: 'text', notNull: true },
    processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('processed_messages', 'processed_messages_pkey', {
    primaryKey: ['event_id', 'message_id', 'consumer'],
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('processed_messages');
}
