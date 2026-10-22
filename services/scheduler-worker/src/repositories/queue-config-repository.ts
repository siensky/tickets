/**
 * Läser väntrummets config-nycklar (docs/plan.md "Väntrum": "ändringsbara
 * live"). Egen, minimal kopia av booking-apis motsvarighet (bara de två
 * nycklar insläppsjobbet faktiskt behöver — inte sessionstotalen, som
 * bara kötokens `exp` bryr sig om) — se docs/rules.md §1.
 */
import { InternalError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { QueueConfig } from '../types/queue-config.js';

const QUEUE_CONFIG_KEYS = [
  'queue_admission_rate_per_minute',
  'queue_session_inactivity_minutes',
] as const;

function parsePositiveInteger(key: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InternalError(`config.${key} is not a positive integer`, { key, rawValue });
  }
  return value;
}

export async function getQueueConfig(pool: Pool): Promise<QueueConfig> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM config WHERE key = ANY($1)',
    [QUEUE_CONFIG_KEYS],
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));

  const admissionRatePerMinute = values.get('queue_admission_rate_per_minute');
  const sessionInactivityMinutes = values.get('queue_session_inactivity_minutes');
  if (admissionRatePerMinute === undefined || sessionInactivityMinutes === undefined) {
    throw new InternalError('Queue config keys are missing from the config table', {
      foundKeys: [...values.keys()],
    });
  }

  return {
    admissionRatePerMinute: parsePositiveInteger(
      'queue_admission_rate_per_minute',
      admissionRatePerMinute,
    ),
    sessionInactivityMinutes: parsePositiveInteger(
      'queue_session_inactivity_minutes',
      sessionInactivityMinutes,
    ),
  };
}
