/**
 * Shard router, connection pools, and the transaction helper for both
 * Postgres shards (docs/plan.md "Databas" — shard key is event_id,
 * global tables live on shard-0). All raw SQL in the system lives behind
 * repositories that import from here (rules.md §4).
 *
 * The migration runner itself is node-pg-migrate via the CLI
 * (scripts/migrate-all-shards.sh), not re-exported as code.
 */
export * from './shard-router.js';
export * from './pools.js';
export * from './transaction.js';
export * from './pg-errors.js';
