/**
 * Invariant check (docs/plan.md "Databas"): every `held` seat points to
 * an active reservation, and every active reservation's seats are
 * actually marked `held` — a denormalized status column can otherwise
 * silently drift apart from the relation it mirrors.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

async function findInvariantViolations(db: TestDatabase): Promise<{
  heldSeatsWithoutActiveReservation: string[];
  activeReservationsWithoutHeldSeats: string[];
}> {
  const pool = db.shardPools.pools[0];
  const heldSeats = await pool.query<{ id: string }>(
    `SELECT s.id FROM seats s
     LEFT JOIN reservations r ON r.id = s.reservation_id AND r.status = 'active'
     WHERE s.status = 'held' AND r.id IS NULL`,
  );
  const activeReservations = await pool.query<{ id: string }>(
    `SELECT r.id FROM reservations r
     WHERE r.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.reservation_id = r.id AND s.status = 'held')`,
  );
  return {
    heldSeatsWithoutActiveReservation: heldSeats.rows.map((row) => row.id),
    activeReservationsWithoutHeldSeats: activeReservations.rows.map((row) => row.id),
  };
}

describe('seats ↔ reservations invariant', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  it('holds after a mix of successful, contested, and multi-seat reservations', async () => {
    const eventId = randomUUID();
    const seatIds = Array.from({ length: 5 }, () => randomUUID());
    await seedEventWithSeats(db.shardPools.pools[0], { eventId, seatIds });

    await Promise.allSettled([
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatIds[0] as string, seatIds[1] as string],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatIds[1] as string, seatIds[2] as string],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      reserveSeats(db.shardPools, {
        eventId,
        seatIds: [seatIds[3] as string],
        queueTokenId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ]);

    const violations = await findInvariantViolations(db);
    expect(violations.heldSeatsWithoutActiveReservation).toEqual([]);
    expect(violations.activeReservationsWithoutHeldSeats).toEqual([]);
  }, 60_000);
});
