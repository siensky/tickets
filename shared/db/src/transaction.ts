/**
 * Transaction helper every repository write goes through (docs/rules.md
 * §4: "Varje skrivande operation i en transaktion"). Acquires a client,
 * runs the callback inside BEGIN/COMMIT, and always rolls back and
 * releases on failure — callers never have to remember the
 * ROLLBACK-on-throw dance themselves.
 */
import type { Pool, PoolClient } from 'pg';

// Pick<Pool, 'connect'> instead of the full Pool class: lets tests pass a
// plain fake { connect: vi.fn(...) } object without a type cast, since
// the real pg.Pool already structurally satisfies this.
export async function withTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rolling back failed too (e.g. the connection already dropped)
      // — the ORIGINAL error below is what actually explains the
      // failure, so it's rethrown either way. Only THEN is the
      // connection possibly poisoned and destroyed by `release()`.
      connectionBroken = true;
    }
    throw error;
  } finally {
    // A successful ROLLBACK leaves a clean connection: hand it back.
    // Destroying it on every expected domain error (a 409 "seat taken"
    // happens thousands of times per sale) made the next caller open a
    // new connection (TCP + auth) while the pool was already the
    // bottleneck (docs/loadtest-cpu-plan.md, run of 5 November).
    client.release(connectionBroken);
  }
}
