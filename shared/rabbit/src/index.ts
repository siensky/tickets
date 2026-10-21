/**
 * RabbitMQ connection and the outbox relay publisher (docs/plan.md
 * "Idempotens" — transactional outbox, at-least-once delivery). The
 * shared consumer base for workers lands in Fas 3 alongside the first
 * real consumers (notification-worker).
 */
export * from './publisher.js';
