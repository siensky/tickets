/**
 * Övergiven betalning mot riktig Postgres: kunden gick till Stripe och kom tillbaka utan att betala.
 * `DELETE` släpper reservationen i `pending_payment` bara när Stripe bekräftar att sessionen gått ut,
 * och då kan samma stolar bokas igen direkt. Är betalningen klar (409) eller Stripe onåbar (503) rörs
 * ingenting, och en ny reservation (`POST`) rör aldrig en betalning.
 */
import { randomUUID } from 'node:crypto';
import {
  ActiveReservationExistsError,
  PaymentProviderUnavailableError,
} from '@tickets/domain';
import { createLogger } from '@tickets/observability';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cancelReservationOrCheckout } from '../../src/services/abandoned-checkout-service.js';
import { deriveOrderId } from '../../src/services/request-hash.js';
import { reserveSeats } from '../../src/services/reservation-service.js';
import {
  getSeatStatuses,
  seedEventWithSeats,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

const logger = createLogger({ serviceName: 'test' });

type StripeBehaviour = 'expires' | 'already-expired' | 'complete' | 'unreachable';

function fakeStripe(behaviour: StripeBehaviour): {
  stripe: Stripe;
  expire: ReturnType<typeof vi.fn>;
} {
  const unreachable = new Error('connect ETIMEDOUT');
  const expire =
    behaviour === 'expires'
      ? vi.fn().mockResolvedValue({ status: 'expired' })
      : vi
          .fn()
          .mockRejectedValue(
            behaviour === 'unreachable' ? unreachable : new Error('not open'),
          );
  const retrieve =
    behaviour === 'unreachable'
      ? vi.fn().mockRejectedValue(unreachable)
      : vi.fn().mockResolvedValue({
          status: behaviour === 'complete' ? 'complete' : 'expired',
        });
  // Fejk med bara de två metoder tjänsten anropar.
  const stripe = { checkout: { sessions: { expire, retrieve } } } as unknown as Stripe;
  return { stripe, expire };
}

/** Samma rader som checkout skriver: order (deterministiskt id), väntande betalning, frusen reservation. */
async function startCheckout(
  pool: Pool,
  eventId: string,
  reservationId: string,
  sessionId: string,
): Promise<void> {
  const userId = randomUUID();
  await pool.query(`INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, $3, 'K')`, [
    userId,
    `auth0|${userId}`,
    `${userId}@example.test`,
  ]);
  const orderId = deriveOrderId(reservationId);
  await pool.query(
    `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
     VALUES ($1, $2, $3, $4, 10000, 'pending')`,
    [orderId, eventId, userId, reservationId],
  );
  await pool.query(
    `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key, amount_cents)
     VALUES ($1, $2, 'stripe', $3, $4, 10000)`,
    [eventId, orderId, sessionId, randomUUID()],
  );
  await pool.query(
    `UPDATE reservations SET status = 'pending_payment', payment_frozen_until = now() + interval '10 minutes'
     WHERE id = $1`,
    [reservationId],
  );
}

describe('abandoned checkout', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  async function reservedAndAtStripe() {
    const pool = db.shardPools.pools[0];
    const eventId = randomUUID();
    const seatIds = [randomUUID(), randomUUID()];
    await seedEventWithSeats(pool, { eventId, seatIds });
    const queueTokenId = randomUUID();
    const reservation = await reserveSeats(db.shardPools, {
      eventId,
      seatIds: [seatIds[0] as string],
      queueTokenId,
      idempotencyKey: randomUUID(),
    });
    const sessionId = `cs_test_${randomUUID()}`;
    await startCheckout(pool, eventId, reservation.reservationId, sessionId);
    return {
      pool,
      eventId,
      seatIds,
      queueTokenId,
      reservationId: reservation.reservationId,
      sessionId,
    };
  }

  async function reservationStatus(
    pool: Pool,
    reservationId: string,
  ): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1',
      [reservationId],
    );
    return rows[0]?.status;
  }

  it.each<StripeBehaviour>(['expires', 'already-expired'])(
    'releases the seats once Stripe confirms the session expired (%s)',
    async (behaviour) => {
      const ctx = await reservedAndAtStripe();
      const { stripe, expire } = fakeStripe(behaviour);

      await cancelReservationOrCheckout(
        { shardPools: db.shardPools, stripe, logger },
        ctx.eventId,
        ctx.reservationId,
        ctx.queueTokenId,
      );

      expect(expire).toHaveBeenCalledWith(ctx.sessionId, {}, expect.anything());
      const statuses = await getSeatStatuses(ctx.pool, [ctx.seatIds[0] as string]);
      expect([...statuses.values()]).toEqual(['available']);
      expect(await reservationStatus(ctx.pool, ctx.reservationId)).toBe('cancelled');
      // Samma stol går att boka igen direkt.
      const again = await reserveSeats(db.shardPools, {
        eventId: ctx.eventId,
        seatIds: [ctx.seatIds[0] as string],
        queueTokenId: ctx.queueTokenId,
        idempotencyKey: randomUUID(),
      });
      expect(again.reservationId).not.toBe(ctx.reservationId);
    },
    60_000,
  );

  it.each<[StripeBehaviour, new (...args: never[]) => Error]>([
    ['complete', ActiveReservationExistsError],
    ['unreachable', PaymentProviderUnavailableError],
  ])(
    'touches nothing when Stripe says %s',
    async (behaviour, expectedError) => {
      const ctx = await reservedAndAtStripe();
      const { stripe } = fakeStripe(behaviour);

      await expect(
        cancelReservationOrCheckout(
          { shardPools: db.shardPools, stripe, logger },
          ctx.eventId,
          ctx.reservationId,
          ctx.queueTokenId,
        ),
      ).rejects.toBeInstanceOf(expectedError);

      const statuses = await getSeatStatuses(ctx.pool, [ctx.seatIds[0] as string]);
      expect([...statuses.values()]).toEqual(['held']);
      expect(await reservationStatus(ctx.pool, ctx.reservationId)).toBe('pending_payment');
    },
    60_000,
  );

  it('a new reservation (POST) never touches a checkout in progress', async () => {
    const ctx = await reservedAndAtStripe();

    await expect(
      reserveSeats(db.shardPools, {
        eventId: ctx.eventId,
        seatIds: [ctx.seatIds[1] as string],
        queueTokenId: ctx.queueTokenId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ActiveReservationExistsError);
    expect(await reservationStatus(ctx.pool, ctx.reservationId)).toBe('pending_payment');
  }, 60_000);

  it("never touches another queue token's checkout", async () => {
    const ctx = await reservedAndAtStripe();
    const { stripe, expire } = fakeStripe('expires');

    await cancelReservationOrCheckout(
      { shardPools: db.shardPools, stripe, logger },
      ctx.eventId,
      ctx.reservationId,
      randomUUID(),
    );

    expect(expire).not.toHaveBeenCalled();
    expect(await reservationStatus(ctx.pool, ctx.reservationId)).toBe('pending_payment');
  }, 60_000);
});
