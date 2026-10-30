/**
 * F5 Reservationen går ut (docs/plan.md 7.14): hållningen sätts till en
 * minut i config och återställs efteråt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, checkout, joinAndAdmit, listAvailableSeats, reserve } from '../helpers/api.js';
import { getAccessToken } from '../helpers/auth.js';
import { closePools, createEvent, deleteConfig, getConfig, setConfig } from '../helpers/db.js';
import { asRecord, str } from '../helpers/json.js';
import { waitFor } from '../helpers/wait-for.js';

const HOLD_KEY = 'reservation_hold_minutes';
let previousHold: string | undefined;

beforeAll(async () => {
  previousHold = await getConfig(HOLD_KEY);
  await setConfig(HOLD_KEY, '1');
});

afterAll(async () => {
  if (previousHold === undefined) {
    await deleteConfig(HOLD_KEY);
  } else {
    await setConfig(HOLD_KEY, previousHold);
  }
  await closePools();
});

describe('F5 reservationen går ut', () => {
  it('släpper stolarna efter utgången och avvisar checkout', async () => {
    const token = await getAccessToken(1);
    const { eventId, sectionId } = await createEvent({ seatCount: 3 });
    const queueToken = await joinAndAdmit(eventId);
    const seatIds = (await listAvailableSeats(eventId, sectionId))
      .slice(0, 2)
      .map((seat) => seat.seatId);
    const reserved = await reserve(eventId, queueToken, seatIds);
    expect(reserved.status).toBe(201);
    const reservationId = str(asRecord(reserved.body), 'reservationId');

    await waitFor(
      'the reservation to expire',
      async () => {
        const view = await call('GET', `/events/${eventId}/reservations/${reservationId}`, {
          queueToken,
        });
        return str(asRecord(view.body), 'status') === 'expired' ? true : undefined;
      },
      150_000,
    );

    const available = await waitFor('the seats to be available again', async () => {
      const seats = await listAvailableSeats(eventId, sectionId);
      return seats.length === 3 ? seats : undefined;
    });
    expect(available).toHaveLength(3);
    const late = await checkout(eventId, reservationId, queueToken, token);
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.status).toBeLessThan(500);
  }, 240_000);
});
