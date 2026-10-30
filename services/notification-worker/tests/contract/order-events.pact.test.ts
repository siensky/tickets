/**
 * Pact-konsumenttest (message pact): booking-api → notification-worker, de tre
 * orderhändelserna som går över RabbitMQ (docs/plan.md 7.9, kontrakt 4).
 * Varje meddelande matas genom den RIKTIGA `processNotificationEvent`.
 * Skriver `pacts/notification-worker-booking-api.json`, som booking-api
 * verifierar i services/booking-api/tests/contract.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matchers, PactV4 } from '@pact-foundation/pact';
import type { ShardPools } from '@tickets/db';
import { createLogger } from '@tickets/observability';
import type { RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import { processNotificationEvent } from '../../src/services/notification-consumer-service.js';

const PACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pacts');
const { uuid, integer, eachLike } = Matchers;
const ORDER_ID = '5b0f1a9e-3c6d-4f7a-8d2e-1a2b3c4d5e6f';
const EVENT_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PAYMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

const pact = new PactV4({
  consumer: 'notification-worker',
  provider: 'booking-api',
  dir: PACTS_DIR,
  logLevel: 'warn',
});

function runConsumer(message: { contents: { content: unknown } }): Promise<string> {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM users'))
      return Promise.resolve({ rows: [{ email: 'buyer@example.test' }] });
    if (sql.includes('FROM orders')) return Promise.resolve({ rows: [{ user_id: USER_ID }] });
    return Promise.resolve({ rows: [] });
  });
  const pool = { query };
  const logger = createLogger({ serviceName: 'pact-test' });
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const redis = { eval: vi.fn().mockResolvedValue(1) } as unknown as RedisClient;
  const shardPools = { pools: [pool, pool] } as unknown as ShardPools;
  const payload: unknown = JSON.parse(JSON.stringify(message.contents.content));
  return processNotificationEvent({ shardPools, redis, logger }, payload, 'msg-1').then(() => {
    const sent = info.mock.calls.map((call) => String(call[1]));
    expect(sent).toHaveLength(1);
    return sent[0] ?? '';
  });
}

describe('booking-api → notification-worker', () => {
  it('order.confirmed skickar orderbekräftelsen', async () => {
    await pact
      .addAsynchronousInteraction()
      .given('a payment succeeded for a reserved order')
      .expectsToReceive('an order.confirmed event', (builder) => {
        builder.withJSONContent({
          orderId: uuid(ORDER_ID),
          eventId: uuid(EVENT_ID),
          userId: uuid(USER_ID),
          ticketIds: eachLike(uuid()),
        });
      })
      .executeTest(async (message) => {
        expect(await runConsumer(message)).toContain('order confirmation');
      });
  });

  it('order.refunded skickar återbetalningsförklaringen', async () => {
    await pact
      .addAsynchronousInteraction()
      .given('a payment succeeded after its reservation expired')
      .expectsToReceive('an order.refunded event', (builder) => {
        builder.withJSONContent({
          paymentId: uuid(PAYMENT_ID),
          orderId: uuid(ORDER_ID),
          eventId: uuid(EVENT_ID),
          reservationId: uuid(),
        });
      })
      .executeTest(async (message) => {
        expect(await runConsumer(message)).toContain('refund explanation');
      });
  });

  it('order.seat_refunded skickar förklaringen för delåterbetalningen', async () => {
    await pact
      .addAsynchronousInteraction()
      .given('some seats of a paid order were sold to someone else')
      .expectsToReceive('an order.seat_refunded event', (builder) => {
        builder.withJSONContent({
          paymentId: uuid(PAYMENT_ID),
          orderId: uuid(ORDER_ID),
          eventId: uuid(EVENT_ID),
          seatIds: eachLike(uuid()),
          amountCents: integer(39_500),
        });
      })
      .executeTest(async (message) => {
        expect(await runConsumer(message)).toContain('partial seat refund');
      });
  });
});
