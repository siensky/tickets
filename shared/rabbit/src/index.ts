/**
 * RabbitMQ connection, the outbox relay publisher, and the shared
 * consumer base (docs/plan.md "Idempotens" — transactional outbox,
 * at-least-once delivery, delivery-limit).
 */
export * from './publisher.js';
export * from './consumer.js';
