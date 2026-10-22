/**
 * Läser en användares e-post för utskick (docs/plan.md "Tjänster":
 * notification-worker). `users` är en global tabell (shard-0) — se
 * docs/rules.md §1, varje tjänst äger sin egen vertikala skiva (samma
 * princip som booking-apis egen users-repository.ts, olika frågor).
 */
import type { Pool } from 'pg';

export async function getUserEmail(pool: Pool, userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ email: string }>(
    'SELECT email FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.email;
}
