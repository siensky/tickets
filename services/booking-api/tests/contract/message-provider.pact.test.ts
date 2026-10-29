/**
 * Pact-providerverifiering av meddelanden från booking-api (docs/plan.md 7.9,
 * kontrakt 4): orderhändelserna till notification-worker och `seat_taken` till
 * realtime-gateway. Meddelandena skapas av den RIKTIGA koden
 * (`processPaymentSucceeded` mot en riktig Postgres, `notifySeatsTaken` mot en
 * riktig Redis), inte byggda för hand i testet. Händelserna läses ur outboxen
 * respektive från Redis-kanalen precis som deras mottagare ser dem.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Verifier } from '@pact-foundation/pact';
import { OUTBOX_EVENT_TYPES, type OutboxEventType } from '@tickets/domain';
import { createOversellMetrics, createRegistry, type Logger } from '@tickets/observability';
import { subscribeToChannel, wsChannel } from '@tickets/redis';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPaymentSucceeded } from '../../src/services/payment-consumer-service.js';
import { markSeat, notifySeatsTaken } from '../../src/services/seat-mark-service.js';
import {
  SILENT_LOGGER,
  startTestDatabase,
  startTestRedis,
  stopTestDatabase,
  stopTestRedis,
  type TestDatabase,
  type TestRedis,
} from '../integration/test-helpers.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const NOTIFICATION_PACT = resolve(PACTS_DIR, 'notification-worker-booking-api.json');
const WS_PACT = resolve(PACTS_DIR, 'realtime-gateway-booking-api.json');
const LOGGER = SILENT_LOGGER as unknown as Logger;

interface Purchase {
  readonly eventId: string;
  readonly orderId: string;
  readonly reservationId: string;
  readonly paymentId: string;
  readonly seatIds: readonly string[];
}

/** Seedar en betalning som väntar på `payment.succeeded`, med reservationen i valt tillstånd. */
async function seedPurchase(
  pool: Pool,
  options: { reservationStatus: 'pending_payment' | 'expired'; seatCount: number },
): Promise<Purchase> {
  const eventId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const reservationId = randomUUID();
  const sectionId = randomUUID();
  const seatIds = Array.from({ length: options.seatCount }, () => randomUUID());
  await pool.query(
    `INSERT INTO events (id, venue_id, title, artist, starts_at, sales_open_at, sales_close_at)
     VALUES ($1, gen_random_uuid(), 'Provider', 'Provider', now() + interval '7 days',
             now() - interval '1 day', now() + interval '6 days')`,
    [eventId],
  );
  await pool.query(`INSERT INTO users (id, auth0_sub, email, name) VALUES ($1, $2, $3, 'P')`, [
    userId,
    `auth0|${userId}`,
    `${userId}@example.test`,
  ]);
  await pool.query(
    `INSERT INTO reservations (id, event_id, queue_token_id, status, expires_at, release_after,
                               payment_frozen_until)
     VALUES ($1, $2, $3, $4, now() + interval '5 minutes', now() + interval '6 minutes',
             now() + interval '10 minutes')`,
    [reservationId, eventId, randomUUID(), options.reservationStatus],
  );
  for (const [index, seatId] of seatIds.entries()) {
    await pool.query(
      `INSERT INTO seats (id, event_id, venue_seat_id, section_id, row, number, ticket_number,
                          price_cents, status, reservation_id)
       VALUES ($1, $2, gen_random_uuid(), $3, 'A', $4, $5, 39500, 'held', $6)`,
      [seatId, eventId, sectionId, index + 1, `T-${seatId}`, reservationId],
    );
  }
  await pool.query(
    `INSERT INTO orders (id, event_id, user_id, reservation_id, total_cents, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [orderId, eventId, userId, reservationId, 39_500 * options.seatCount],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key,
                           amount_cents, status)
     VALUES ($1, $2, 'stripe', $3, $4, $5, 'pending') RETURNING id`,
    [eventId, orderId, `cs_${orderId}`, randomUUID(), 39_500 * options.seatCount],
  );
  return { eventId, orderId, reservationId, paymentId: rows[0]?.id ?? '', seatIds };
}

describe('booking-api message provider verification', () => {
  let db: TestDatabase;
  let redis: TestRedis;
  const stripe = new Stripe('sk_test_contract');
  stripe.refunds.create = (() =>
    Promise.resolve({ id: 're_contract' })) as unknown as typeof stripe.refunds.create;

  beforeAll(async () => {
    for (const file of [NOTIFICATION_PACT, WS_PACT]) {
      if (!existsSync(file)) {
        throw new Error(
          `${file} is missing. Run the consumer pact tests first (pnpm test:contract).`,
        );
      }
    }
    [db, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopTestDatabase(db), stopTestRedis(redis)]);
  });

  async function outboxPayload(purchase: Purchase, type: OutboxEventType): Promise<unknown> {
    const { rows } = await db.shardPools.pools[0].query<{ payload: unknown }>(
      'SELECT payload FROM outbox WHERE event_id = $1 AND type = $2',
      [purchase.eventId, type],
    );
    expect(rows).toHaveLength(1);
    return rows[0]?.payload;
  }

  async function runPayment(purchase: Purchase): Promise<void> {
    await processPaymentSucceeded(
      {
        shardPools: db.shardPools,
        stripe,
        qrTokenSecret: 'contract-qr-secret',
        logger: LOGGER,
        oversellMetrics: createOversellMetrics(createRegistry('contract')),
      },
      {
        paymentId: purchase.paymentId,
        orderId: purchase.orderId,
        reservationId: purchase.reservationId,
        eventId: purchase.eventId,
        providerRef: `cs_${purchase.orderId}`,
        providerChargeRef: 'pi_contract',
      },
      randomUUID(),
    );
  }

  it('uppfyller kontrakten för orderhändelserna och seat_taken', async () => {
    const pool = db.shardPools.pools[0];
    const noState = (): Promise<void> => Promise.resolve();

    await new Verifier({
      provider: 'booking-api',
      pactUrls: [NOTIFICATION_PACT, WS_PACT],
      stateHandlers: {
        'a payment succeeded for a reserved order': noState,
        'a payment succeeded after its reservation expired': noState,
        'some seats of a paid order were sold to someone else': noState,
        'another queue token holds a mark on a seat that was just reserved': noState,
      },
      messageProviders: {
        'an order.confirmed event': async () => {
          const purchase = await seedPurchase(pool, {
            reservationStatus: 'pending_payment',
            seatCount: 2,
          });
          await runPayment(purchase);
          return outboxPayload(purchase, OUTBOX_EVENT_TYPES.ORDER_CONFIRMED);
        },
        'an order.refunded event': async () => {
          const purchase = await seedPurchase(pool, {
            reservationStatus: 'expired',
            seatCount: 1,
          });
          await runPayment(purchase);
          return outboxPayload(purchase, OUTBOX_EVENT_TYPES.ORDER_REFUNDED);
        },
        'an order.seat_refunded event': async () => {
          const purchase = await seedPurchase(pool, {
            reservationStatus: 'pending_payment',
            seatCount: 2,
          });
          // Någon annan äger redan en giltig biljett på första stolen: det förlorade racet.
          const otherOrderId = randomUUID();
          await pool.query(
            `INSERT INTO orders (id, event_id, user_id, total_cents, status)
             SELECT $1, $2, user_id, 39500, 'paid' FROM orders WHERE id = $3`,
            [otherOrderId, purchase.eventId, purchase.orderId],
          );
          await pool.query(
            `INSERT INTO tickets (event_id, order_id, seat_id, qr_token, status)
             VALUES ($1, $2, $3, 'other-qr', 'valid')`,
            [purchase.eventId, otherOrderId, purchase.seatIds[0]],
          );
          await runPayment(purchase);
          return outboxPayload(purchase, OUTBOX_EVENT_TYPES.ORDER_SEAT_REFUNDED);
        },
        'a seat_taken message': async () => {
          const eventId = randomUUID();
          const seatId = randomUUID();
          const holder = randomUUID();
          const deps = { redis: redis.client, logger: LOGGER };
          await markSeat(deps, { eventId, seatId, queueTokenId: holder });
          let resolveMessage: (payload: unknown) => void = () => undefined;
          const received = new Promise<unknown>((resolve) => {
            resolveMessage = resolve;
          });
          const subscription = await subscribeToChannel(
            redis.client,
            wsChannel(holder),
            resolveMessage,
          );
          await notifySeatsTaken(deps, {
            eventId,
            seatIds: [seatId],
            takenByQueueTokenId: randomUUID(),
          });
          try {
            return await received;
          } finally {
            await subscription.unsubscribe();
          }
        },
      },
      logLevel: 'warn',
    }).verifyProvider();
  }, 120_000);
});
