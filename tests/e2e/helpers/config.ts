/** Läser och sätter rader i `config` (global databas, shard 0), t.ex. reservationens hålltid. */
import { Pool } from 'pg';

function createPool(): Pool {
  return new Pool({
    connectionString:
      process.env['DATABASE_URL_SHARD_0'] ??
      'postgresql://postgres:postgres@localhost:5432/tickets',
  });
}

export async function readConfig(key: string): Promise<string | undefined> {
  const pool = createPool();
  try {
    const result = await pool.query<{ value: string }>(
      'SELECT value FROM config WHERE key = $1',
      [key],
    );
    return result.rows[0]?.value;
  } finally {
    await pool.end();
  }
}

export async function writeConfig(key: string, value: string | undefined): Promise<void> {
  const pool = createPool();
  try {
    if (value === undefined) {
      await pool.query('DELETE FROM config WHERE key = $1', [key]);
    } else {
      await pool.query(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
    }
  } finally {
    await pool.end();
  }
}
