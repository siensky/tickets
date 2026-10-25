/**
 * `users` — global (shard-0) table, upserted on first authenticated
 * request (docs/plan.md "Auth": "Inloggning krävs först vid betalning"
 * — checkout is the first point a real identity appears in the system,
 * so this is where a `users` row gets created, not a separate signup
 * step).
 */
import type { Pool } from 'pg';

/**
 * Read-only lookup for "mina biljetter" (docs/plan.md): a user who has
 * never reached checkout has no `users` row yet, and that is a normal,
 * empty-tickets-list outcome — not an error, so this returns
 * `undefined` instead of upserting one (unlike `ensureUser`, which is
 * only for the checkout write path).
 */
export async function getUserByAuth0Sub(
  pool: Pool,
  auth0Sub: string,
): Promise<{ id: string } | undefined> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE auth0_sub = $1',
    [auth0Sub],
  );
  return rows[0];
}

export async function ensureUser(
  pool: Pool,
  params: { auth0Sub: string; email: string; name: string | undefined },
): Promise<{ id: string }> {
  // `name` is NOT NULL (schema) — Auth0's `name` claim depends on the
  // scopes requested and isn't guaranteed, so fall back to the email
  // rather than fail the whole checkout over a missing display name.
  const name = params.name ?? params.email;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (id, auth0_sub, email, name)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (auth0_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id`,
    [params.auth0Sub, params.email, name],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('ensureUser: INSERT ... RETURNING produced no row');
  }
  return { id: row.id };
}
