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
    holdMinutes: Number(holdMinutes),
    releaseJitterMaxSeconds: Number(releaseJitterMaxSeconds),
    maxSeatsPerReservation: Number(maxSeatsPerReservation),
  };
}
