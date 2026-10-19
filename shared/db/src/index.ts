/**
 * Shard router, connection pools, and the migration runner for both
 * Postgres shards (docs/plan.md "Databas" — shard key is event_id,
 * global tables live on shard-0). All raw SQL in the system lives behind
 * repositories that import from here (rules.md §4).
 *
 * Implemented in Fas 2 (docs/plan.md fasplan). Package scaffolded now so
 * the workspace layout is final from day one.
 */
export const DB_PACKAGE_NAME = '@tickets/db';
