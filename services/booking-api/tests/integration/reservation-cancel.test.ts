/**
 * Avbryt bokningen (bakåtpil/"Avbryt") mot riktig Postgres: kötokenens egen aktiva reservation
 * avbryts och stolarna släpps; en reservation i betalning, någon annans reservation och en
 * redan avslutad reservation rörs inte. Dessutom `heldUntil` i stolsstatusen.
 */
import { randomUUID } from 'node:crypto';
import { SeatUnavailableError } from '@tickets/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSeatStatusesForSection } from '../../src/repositories/seats-repository.js';
import { cancelReservation, reserveSeats } from '../../src/services/reservation-service.js';
import {
  getSeatStatuses,
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

describe('cancelReservation', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  async function reserve(eventId: string, seatIds: string[], queueTokenId: string) {
    return reserveSeats(db.shardPools, {
      eventId,
      seatIds,
      queueTokenId,
      idempotencyKey: randomUUID(),
    });
  }

  it("cancels the caller's active reservation and frees its seats", async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const queueTokenId = randomUUID();
    const reservation = await reserve(eventId, seatIds, queueTokenId);

    await cancelReservation(db.shardPools, eventId, reservation.reservationId, queueTokenId);

    const statuses = await getSeatStatuses(pool, seatIds);
    expect([...statuses.values()]).toEqual(['available', 'available']);
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [reservation.reservationId],
    );
    expect(rows[0]?.status).toBe('cancelled');
  }, 60_000);

  it('is idempotent and a no-op when there is nothing to cancel', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    await seedEventWithSeats(pool, { eventId, seatIds: [randomUUID()] });

    await expect(
      cancelReservation(db.shardPools, eventId, randomUUID(), randomUUID()),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("leaves another queue token's reservation and a payment in progress alone", async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const mine = randomUUID();
    const other = randomUUID();
    const otherReservation = await reserve(eventId, [seatIds[0] as string], other);
    const paying = await reserve(eventId, [seatIds[1] as string], mine);
    await pool.query("UPDATE reservations SET status = 'pending_payment' WHERE id = $1", [
      paying.reservationId,
    ]);

    await cancelReservation(db.shardPools, eventId, paying.reservationId, mine);
    await cancelReservation(db.shardPools, eventId, otherReservation.reservationId, mine);

    const statuses = await getSeatStatuses(pool, seatIds);
    expect([...statuses.values()]).toEqual(['held', 'held']);
  }, 60_000);

  it('lets the caller reserve the same seats again right after cancelling', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const queueTokenId = randomUUID();
    const first = await reserve(eventId, seatIds, queueTokenId);
    await cancelReservation(db.shardPools, eventId, first.reservationId, queueTokenId);

    const again = await reserve(eventId, seatIds, queueTokenId);

    expect(again.seatIds).toEqual(seatIds);
  }, 60_000);

  it('reports when an active reservation expires (heldUntil) and nothing for other seats', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID(), randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const sectionId = randomUUID();
    await pool.query('UPDATE seats SET section_id = $2 WHERE event_id = $1', [
      eventId,
      sectionId,
    ]);
    const reservation = await reserve(eventId, [seatIds[0] as string], randomUUID());
    const paying = await reserve(eventId, [seatIds[1] as string], randomUUID());
    await pool.query("UPDATE reservations SET status = 'pending_payment' WHERE id = $1", [
      paying.reservationId,
    ]);

    const rows = await listSeatStatusesForSection(pool, eventId, sectionId);
    const bySeat = new Map(rows.map((row) => [row.id, row]));

    expect(bySeat.get(seatIds[0] as string)?.heldUntil?.toISOString()).toBe(
      reservation.expiresAt,
    );
    expect(bySeat.get(seatIds[1] as string)?.heldUntil).toBeNull();
    expect(bySeat.get(seatIds[2] as string)?.heldUntil).toBeNull();
  }, 60_000);

  it('cancels only the reservation with the given id, never a newer one of the same token', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const queueTokenId = randomUUID();
    const old = await reserve(eventId, [seatIds[0] as string], queueTokenId);
    const newer = await reserve(eventId, [seatIds[1] as string], queueTokenId);

    // Ett sent avbokningsanrop för den gamla reservationen får inte röra den nyare.
    await cancelReservation(db.shardPools, eventId, old.reservationId, queueTokenId);

    const statuses = await getSeatStatuses(pool, seatIds);
    expect(statuses.get(seatIds[1] as string)).toBe('held');
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [newer.reservationId],
    );
    expect(rows[0]?.status).toBe('active');
  }, 60_000);

  it('fails with a retryable 409 instead of waiting when a seat is locked by someone else', async () => {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const queueTokenId = randomUUID();
    const reservation = await reserve(eventId, seatIds, queueTokenId);

    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM seats WHERE id = $1 FOR UPDATE', [seatIds[0]]);
      await expect(
        cancelReservation(db.shardPools, eventId, reservation.reservationId, queueTokenId),
      ).rejects.toBeInstanceOf(SeatUnavailableError);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    // Efter att låset släppts går avbokningen igenom.
    await cancelReservation(db.shardPools, eventId, reservation.reservationId, queueTokenId);
    const statuses = await getSeatStatuses(pool, seatIds);
    expect(statuses.get(seatIds[0] as string)).toBe('available');
  }, 60_000);
});
