/**
 * PostHog-händelserna från betalningskonsumenten (docs/plan.md 7.7): `payment_succeeded`
 * skickas exakt en gång per betalning, med köparens Auth0 `sub`, även när samma meddelande
 * levereras flera gånger (dubbel webhook → redelivery). Postgres är riktig; det som ersätts är
 * bara PostHog-klienten, via ett eget `ServerAnalytics`.
 */
import type { ServerAnalytics } from '@tickets/analytics/server';
import type { Logger, OversellMetrics } from '@tickets/observability';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processPaymentSucceeded,
  type PaymentConsumerDeps,
} from '../../src/services/payment-consumer-service.js';
import { seedPurchase } from './purchase-fixture.js';
import {
  SILENT_LOGGER,
  startTestDatabase,
  stopTestDatabase,
  type TestDatabase,
} from './test-helpers.js';

describe('payment analytics', () => {
  let db: TestDatabase;
  const track = vi.fn();
  const analytics: ServerAnalytics = { track, shutdown: () => Promise.resolve() };
  const stripe = new Stripe('sk_test_analytics');
  stripe.refunds.create = (() =>
    Promise.resolve({ id: 're_analytics' })) as unknown as typeof stripe.refunds.create;

  function deps(): PaymentConsumerDeps {
    return {
      shardPools: db.shardPools,
      stripe,
      qrTokenSecret: 'analytics-qr-secret',
      logger: SILENT_LOGGER as unknown as Logger,
      oversellMetrics: {
        oversellPreventedTotal: { inc: () => undefined },
      } as unknown as OversellMetrics,
      analytics,
    };
  }

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  beforeEach(() => track.mockClear());

  it('skickar payment_succeeded exakt en gång, även när meddelandet levereras igen', async () => {
    const purchase = await seedPurchase(db.shardPools.pools[0], {
      reservationStatus: 'pending_payment',
      seatCount: 2,
    });
    const payload = {
      paymentId: purchase.paymentId,
      orderId: purchase.orderId,
      reservationId: purchase.reservationId,
      eventId: purchase.eventId,
      providerRef: `cs_${purchase.orderId}`,
      providerChargeRef: 'pi_analytics',
    };

    await processPaymentSucceeded(deps(), payload, 'message-1');
    await processPaymentSucceeded(deps(), payload, 'message-1');

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(`auth0|${purchase.userId}`, 'payment_succeeded', {
      order_id: purchase.orderId,
      event_id: purchase.eventId,
      seat_count: 2,
      total_sek: 790,
    });
  });

  it('skickar payment_late_refunded exakt en gång när betalningen kommer efter utgången reservation', async () => {
    const purchase = await seedPurchase(db.shardPools.pools[0], {
      reservationStatus: 'expired',
      seatCount: 1,
    });
    const payload = {
      paymentId: purchase.paymentId,
      orderId: purchase.orderId,
      reservationId: purchase.reservationId,
      eventId: purchase.eventId,
      providerRef: `cs_${purchase.orderId}`,
      providerChargeRef: 'pi_late',
    };

    await processPaymentSucceeded(deps(), payload, 'message-late');
    await processPaymentSucceeded(deps(), payload, 'message-late');

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(`auth0|${purchase.userId}`, 'payment_late_refunded', {
      order_id: purchase.orderId,
      event_id: purchase.eventId,
    });
  });
});
