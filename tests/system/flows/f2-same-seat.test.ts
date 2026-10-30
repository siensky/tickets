/**
 * F2 Samma stol, två köpare (docs/plan.md 7.14): exakt en reservation lyckas.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { joinAndAdmit, listAvailableSeats, reserve } from '../helpers/api.js';
import { closePools, createEvent, queryBothShards } from '../helpers/db.js';

afterAll(closePools);

describe('F2 samma stol, två köpare', () => {
  it('ger exakt en 201 och en 409 när två kötoken reserverar samma stol samtidigt', async () => {
    const { eventId, sectionId } = await createEvent({ seatCount: 4 });
    const [first, second] = await Promise.all([joinAndAdmit(eventId), joinAndAdmit(eventId)]);
    const [seat] = await listAvailableSeats(eventId, sectionId);
    expect(seat).toBeDefined();
    const seatId = seat?.seatId ?? '';

    const results = await Promise.all([
      reserve(eventId, first, [seatId]),
      reserve(eventId, second, [seatId]),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const holders = await queryBothShards<{ reservation_id: string | null; status: string }>(
      `SELECT s.reservation_id, s.status FROM seats s WHERE s.event_id = $1 AND s.id = $2`,
      [eventId, seatId],
    );
    const held = holders.filter((row) => row.reservation_id !== null);
    expect(held).toHaveLength(1);
    expect(held[0]?.status).toBe('held');
    const active = await queryBothShards<{ id: string }>(
      `SELECT r.id FROM reservations r
       JOIN seats s ON s.reservation_id = r.id AND s.event_id = r.event_id
       WHERE r.event_id = $1 AND s.id = $2 AND r.status = 'active'`,
      [eventId, seatId],
    );
    expect(active).toHaveLength(1);
  });
});
