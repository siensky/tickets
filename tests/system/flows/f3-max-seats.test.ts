/**
 * F3 Max 5 stolar (docs/plan.md 7.14).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { joinAndAdmit, listAvailableSeats, reserve } from '../helpers/api.js';
import { closePools, createEvent, queryBothShards } from '../helpers/db.js';

afterAll(closePools);

describe('F3 max 5 stolar', () => {
  it('avvisar en reservation på sex stolar och lämnar alla stolar orörda', async () => {
    const { eventId, sectionId } = await createEvent({ seatCount: 8 });
    const queueToken = await joinAndAdmit(eventId);
    const seatIds = (await listAvailableSeats(eventId, sectionId))
      .slice(0, 6)
      .map((seat) => seat.seatId);
    expect(seatIds).toHaveLength(6);

    const response = await reserve(eventId, queueToken, seatIds);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const changed = await queryBothShards<{ id: string }>(
      `SELECT id FROM seats WHERE event_id = $1 AND (status <> 'available' OR reservation_id IS NOT NULL)`,
      [eventId],
    );
    expect(changed).toHaveLength(0);
  });
});
