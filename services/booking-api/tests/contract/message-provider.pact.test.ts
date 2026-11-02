/**
 * Pact-providerverifiering av meddelanden från booking-api (docs/plan.md 7.9,
 * kontrakt 4): orderhändelserna till notification-worker och `seat_taken` till
 * realtime-gateway. Meddelandena skapas av den RIKTIGA koden
 * (`processPaymentSucceeded` mot en riktig Postgres, `notifySeatsTaken` mot en
 * riktig Redis), inte byggda för hand i testet. Händelserna läses ur outboxen
 * respektive från Redis-kanalen precis som deras mottagare ser dem.
 */
import { NOOP_SERVER_ANALYTICS } from '@tickets/analytics/server';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Verifier } from '@pact-foundation/pact';
import { OUTBOX_EVENT_TYPES, type OutboxEventType } from '@tickets/domain';
import { createOversellMetrics, createRegistry, type Logger } from '@tickets/observability';
import { subscribeToChannel, wsChannel } from '@tickets/redis';
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
import { seedPurchase, type Purchase } from '../integration/purchase-fixture.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const NOTIFICATION_PACT = resolve(PACTS_DIR, 'notification-worker-booking-api.json');
const WS_PACT = resolve(PACTS_DIR, 'realtime-gateway-booking-api.json');
const LOGGER = SILENT_LOGGER as unknown as Logger;

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
        analytics: NOOP_SERVER_ANALYTICS,
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
