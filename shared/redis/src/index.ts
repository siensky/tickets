/**
 * Redis client, key-naming conventions, and Lua scripts for atomic
 * operations (docs/plan.md "Redis — användningsområden": waiting-room
 * ZSET, queue tokens, seatmap cache, rate limiting, PoW challenges,
 * notification dedupe, config cache, pub/sub between pods).
 *
 * Implemented starting Fas 2. Package scaffolded now so the workspace
 * layout is final from day one.
 */
export const REDIS_PACKAGE_NAME = '@tickets/redis';
