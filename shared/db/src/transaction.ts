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
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
