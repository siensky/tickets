/**
 * Reads the reservation-related settings the plan says must be
 * changeable live, not hardcoded (docs/plan.md "Databas": "config styr:
 * ... max stolar/bokning"). `config` is a global table — always read
 * from shard-0 via `getGlobalPool`, never from the event's shard.
 */
import { InternalError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { ChallengeConfig } from '../types/challenge.js';
import type { QueueConfig } from '../types/queue.js';
import type { ReservationConfig } from '../types/reservation.js';

const CONFIG_KEYS = [
  'reservation_hold_minutes',
  'reservation_release_jitter_max_seconds',
  'max_seats_per_reservation',
] as const;

const QUEUE_CONFIG_KEYS = [
  'queue_admission_rate_per_minute',
  'queue_session_total_minutes',
  'queue_session_inactivity_minutes',
  'queue_direct_admit_limit',
] as const;

export async function getReservationConfig(pool: Pool): Promise<ReservationConfig> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM config WHERE key = ANY($1)',
    [CONFIG_KEYS],
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));

  const holdMinutes = values.get('reservation_hold_minutes');
  const releaseJitterMaxSeconds = values.get('reservation_release_jitter_max_seconds');
  const maxSeatsPerReservation = values.get('max_seats_per_reservation');
  if (
    holdMinutes === undefined ||
    releaseJitterMaxSeconds === undefined ||
    maxSeatsPerReservation === undefined
  ) {
    // Seeded by the config migration — missing means a migration didn't
    // run, which is an operational bug, not a user-facing 4xx.
    throw new InternalError('Reservation config keys are missing from the config table', {
      foundKeys: [...values.keys()],
    });
  }

  return {
    holdMinutes: parsePositiveInteger('reservation_hold_minutes', holdMinutes),
    releaseJitterMaxSeconds: parsePositiveInteger(
      'reservation_release_jitter_max_seconds',
      releaseJitterMaxSeconds,
    ),
    maxSeatsPerReservation: parsePositiveInteger(
      'max_seats_per_reservation',
      maxSeatsPerReservation,
    ),
  };
}

/**
 * `config` is "ändringsbar live" (docs/plan.md) — a bad value can be
 * written at any time, not just by a migration. `Number('bad')` is
 * `NaN`, and `NaN` makes every comparison false, including
 * `seatIds.length > maxSeatsPerReservation` — a malformed config value
 * would silently DISABLE the max-seats-per-booking anti-scalping
 * control instead of failing loudly. Validating on read turns that
 * into an immediate, alertable `InternalError` instead.
 */
export async function getQueueConfig(pool: Pool): Promise<QueueConfig> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM config WHERE key = ANY($1)',
    [QUEUE_CONFIG_KEYS],
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));

  const admissionRatePerMinute = values.get('queue_admission_rate_per_minute');
  const sessionTotalMinutes = values.get('queue_session_total_minutes');
  const sessionInactivityMinutes = values.get('queue_session_inactivity_minutes');
  const directAdmitLimit = values.get('queue_direct_admit_limit');
  if (
    admissionRatePerMinute === undefined ||
    sessionTotalMinutes === undefined ||
    sessionInactivityMinutes === undefined ||
    directAdmitLimit === undefined
  ) {
    throw new InternalError('Queue config keys are missing from the config table', {
      foundKeys: [...values.keys()],
    });
  }

  return {
    admissionRatePerMinute: parsePositiveInteger(
      'queue_admission_rate_per_minute',
      admissionRatePerMinute,
    ),
    sessionTotalMinutes: parsePositiveInteger(
      'queue_session_total_minutes',
      sessionTotalMinutes,
    ),
    sessionInactivityMinutes: parsePositiveInteger(
      'queue_session_inactivity_minutes',
      sessionInactivityMinutes,
    ),
    directAdmitLimit: parseNonNegativeInteger('queue_direct_admit_limit', directAdmitLimit),
  };
}

export function parsePositiveInteger(key: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InternalError(`config.${key} is not a positive integer`, { key, rawValue });
  }
  return value;
}

/** Som `parsePositiveInteger`, men 0 är giltigt (t.ex. `queue_direct_admit_limit = 0`: alla köar). */
export function parseNonNegativeInteger(key: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new InternalError(`config.${key} is not a non-negative integer`, { key, rawValue });
  }
  return value;
}

const CHALLENGE_DEFAULTS = {
  challenge_enabled: '1',
  challenge_ip_attempts_per_minute: '30',
  challenge_ip_joins_per_window: '10',
  challenge_global_queue_depth: '0',
  challenge_pow_bits: '16',
} as const;

/**
 * Botskyddets inställningar (docs/plan.md 8.5). Saknade nycklar får samma standardvärden som migrationen
 * seedar, så ett försenat migrationsjobb aldrig stoppar `queue/join`; ett ogiltigt värde ger däremot ett
 * larmbart `InternalError` (samma princip som övrig config).
 */
export async function getChallengeConfig(pool: Pool): Promise<ChallengeConfig> {
  const keys = Object.keys(CHALLENGE_DEFAULTS);
  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM config WHERE key = ANY($1)',
    [keys],
  );
  const values = new Map<string, string>(Object.entries(CHALLENGE_DEFAULTS));
  for (const row of rows) {
    values.set(row.key, row.value);
  }
  const read = (key: keyof typeof CHALLENGE_DEFAULTS): string => values.get(key) ?? '';
  return {
    enabled: parseNonNegativeInteger('challenge_enabled', read('challenge_enabled')) !== 0,
    ipAttemptsPerMinute: parseNonNegativeInteger(
      'challenge_ip_attempts_per_minute',
      read('challenge_ip_attempts_per_minute'),
    ),
    ipJoinsPerWindow: parseNonNegativeInteger(
      'challenge_ip_joins_per_window',
      read('challenge_ip_joins_per_window'),
    ),
    globalQueueDepth: parseNonNegativeInteger(
      'challenge_global_queue_depth',
      read('challenge_global_queue_depth'),
    ),
    powBits: parsePowBits(read('challenge_pow_bits')),
  };
}

/** Läser tillbaka konfigurationen som `getChallengeConfig` cachade som JSON i Redis (5 s), fält för fält. */
export function parseChallengeConfig(raw: string): ChallengeConfig {
  const data: unknown = JSON.parse(raw);
  const field = (name: string): unknown =>
    typeof data === 'object' && data !== null ? Reflect.get(data, name) : undefined;
  const count = (name: string): number => {
    const value = field(name);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new InternalError(`cached challenge config field ${name} is invalid`, { name });
    }
    return value;
  };
  return {
    enabled: field('enabled') === true,
    ipAttemptsPerMinute: count('ipAttemptsPerMinute'),
    ipJoinsPerWindow: count('ipJoinsPerWindow'),
    globalQueueDepth: count('globalQueueDepth'),
    powBits: count('powBits'),
  };
}

const MAX_POW_BITS = 24;

/** 1–24 (samma tak som servern accepterar i en utmaning): högre skulle göra varje lösning ogiltig. */
function parsePowBits(raw: string): number {
  const bits = parsePositiveInteger('challenge_pow_bits', raw);
  if (bits > MAX_POW_BITS) {
    throw new InternalError(`config.challenge_pow_bits must be at most ${MAX_POW_BITS}`, {
      raw,
    });
  }
  return bits;
}
