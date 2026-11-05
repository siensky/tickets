/**
 * Narrow `unknown` catch values down to specific Postgres error
 * conditions repositories and services react to differently
 * (docs/rules.md §5: domain errors, not raw driver errors, cross a
 * layer boundary). `node-postgres` doesn't export a typed error class
 * for this — every error it throws just has `.code` set to the
 * SQLSTATE string. Lives in `@tickets/db` (not booking-api) so both
 * repositories and services in any consuming service can use it
 * without violating the layer boundary (`repositories` may import
 * `shared`, never a sibling service's `services/`).
 */

interface PgErrorLike {
  readonly code: string;
  readonly constraint?: string;
}

function isPgErrorLike(error: unknown): error is PgErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

/** SQLSTATE 23505 = unique_violation. */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  return isPgErrorLike(error) && error.code === '23505' && error.constraint === constraintName;
}

/** SQLSTATE 55P03 = lock_not_available (what `FOR UPDATE NOWAIT` throws). */
export function isLockNotAvailable(error: unknown): boolean {
  return isPgErrorLike(error) && error.code === '55P03';
}

/** SQLSTATE 40P01 = deadlock_detected. Postgres aborted one side of a lock cycle. */
export function isDeadlockDetected(error: unknown): boolean {
  return isPgErrorLike(error) && error.code === '40P01';
}

/**
 * pg-pool's own messages (no SQLSTATE): every connection in the pool stayed busy for longer than
 * `connectionTimeoutMillis`, or a new connection to Postgres didn't open in time. Both mean "overloaded
 * right now, try again", not a bug, so the error handler answers 503 instead of 500.
 */
const CONNECTION_TIMEOUT_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

export function isConnectionTimeout(error: unknown): boolean {
  return error instanceof Error && CONNECTION_TIMEOUT_MESSAGES.has(error.message);
}
