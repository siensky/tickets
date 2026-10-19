/**
 * RabbitMQ connection, the outbox relay publisher, and the shared
 * consumer base that every worker builds on (docs/plan.md "Idempotens" —
 * transactional outbox, at-least-once delivery, consumer dedupe).
 *
 * Implemented in Fas 2 (outbox relay) and Fas 3 (consumers). Package
 * scaffolded now so the workspace layout is final from day one.
 */
export const RABBIT_PACKAGE_NAME = '@tickets/rabbit';
