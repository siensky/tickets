/**
 * Reads the reservation-related settings the plan says must be
 * changeable live, not hardcoded (docs/plan.md "Databas": "config styr:
 * ... max stolar/bokning"). `config` is a global table — always read
 * from shard-0 via `getGlobalPool`, never from the event's shard.
 */
import { InternalError } from '@tickets/domain';
import type { Pool } from 'pg';
import type { ReservationConfig } from '../types/reservation.js';

const CONFIG_KEYS = [
  'reservation_hold_minutes',
  'reservation_release_jitter_max_seconds',
  'max_seats_per_reservation',
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
export function parsePositiveInteger(key: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InternalError(`config.${key} is not a positive integer`, { key, rawValue });
  }
  return value;
}
