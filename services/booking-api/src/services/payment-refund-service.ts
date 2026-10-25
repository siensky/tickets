/**
 * The two ways `payment-consumer-service.ts` gives money back without ever
 * keeping it for nothing (docs/plan.md "Betalning som landar efter
 * utgången reservation", "Oversell"): a full refund when a payment lands
 * after its reservation already expired, or a partial one when only some
 * of an order's seats lost the `tickets_valid_seat_unique` race. Split out
 * purely to keep payment-consumer-service.ts under docs/rules.md's
 * 300-line file limit — both still only ever run from there.
 */
import { withTransaction } from '@tickets/db';
import {
  OUTBOX_EVENT_TYPES,
  type OrderRefundedPayload,
  type OrderSeatRefundedPayload,
  type PaymentSucceededPayload,
} from '@tickets/domain';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import { insertOutboxEvent } from '../repositories/outbox-repository.js';
import { markOrderStatus } from '../repositories/orders-repository.js';
import { markPaymentStatus } from '../repositories/payments-repository.js';

export interface RefundedSeat {
  readonly seatId: string;
  readonly priceCents: number;
}

/**
 * Skyddsnätet (docs/plan.md "Betalning som landar efter utgången
 * reservation"): frysningen löste det normala fallet, men hann den gå
 * ut INNAN betalningen bekräftades är pengarna redan dragna och
 * stolarna redan sålda till någon annan — återbetala, berätta för
 * kunden, aldrig behåll pengarna utan motprestation.
 *
 * Stripe-anropet ligger medvetet UTANFÖR transaktionen nedan, av samma
 * skäl som i checkout-service.ts — men ordern/betalningen flaggas redan
 * `refund_needed`-läge av den FÖRRA transaktionen (reservationen är
 * redan konstaterat förlorad där), så ett krasch MELLAN detta anrop och
 * nästa transaktion lämnar bara en försenad återbetalning, aldrig en
 * dubbel eller en utebliven.
 */
export async function refundAndNotify(
  stripe: Stripe,
  pool: Pool,
  payload: PaymentSucceededPayload,
): Promise<void> {
  await stripe.refunds.create(
    { payment_intent: payload.providerChargeRef },
    { idempotencyKey: `refund:${payload.paymentId}` },
  );
  await withTransaction(pool, async (client) => {
    // Villkorat UPDATE: gör hela funktionen säker att köra flera
    // gånger (se anropsplatsen i processPaymentSucceeded). Har ett
    // tidigare försök redan hunnit flippa statusen till "refunded"
    // ska vi inte avbryta ordern eller skriva outbox-händelsen igen.
    const statusFlipped = await markPaymentStatus(
      client,
      payload.eventId,
      payload.paymentId,
      'refund_needed',
      'refunded',
    );
    if (!statusFlipped) {
      return;
    }
    await markOrderStatus(client, payload.eventId, payload.orderId, 'pending', 'cancelled');
    const refundedPayload: OrderRefundedPayload = {
      paymentId: payload.paymentId,
      orderId: payload.orderId,
      eventId: payload.eventId,
      reservationId: payload.reservationId,
    };
    await insertOutboxEvent(client, {
      eventId: payload.eventId,
      type: OUTBOX_EVENT_TYPES.ORDER_REFUNDED,
      payload: refundedPayload,
    });
  });
}

/**
 * The rest of `refundAndNotify`'s header comment applies here too — the
 * Stripe call is outside the transaction, deliberately.
 *
 * Idempotency relies on `refundedSeats` being the SAME set across retries,
 * not on a separate "already refunded" marker: it's recomputed from the
 * `tickets` table itself (payment-consumer-service.ts's
 * getUnticketedReservedSeats), which only ever grows more complete, never
 * regresses — so a redelivery after a crash between the Stripe call and
 * this outbox write recomputes the identical amount, and Stripe's own
 * idempotencyKey makes the refund call itself safe to repeat. The outbox
 * write below is NOT behind that same idempotency key, though — a crash
 * between the two could in theory send the "seat refunded" email twice.
 * Accepted: docs/plan.md "Idempotens" already tolerates a duplicate
 * notification-worker email as "bara irriterande, inte farligt", unlike a
 * duplicate charge.
 */
export async function refundSeatsAndNotify(
  stripe: Stripe,
  pool: Pool,
  payload: PaymentSucceededPayload,
  refundedSeats: readonly RefundedSeat[],
): Promise<void> {
  const amountCents = refundedSeats.reduce((sum, seat) => sum + seat.priceCents, 0);
  await stripe.refunds.create(
    { payment_intent: payload.providerChargeRef, amount: amountCents },
    { idempotencyKey: `partial-refund:${payload.paymentId}` },
  );
  await withTransaction(pool, async (client) => {
    const seatRefundedPayload: OrderSeatRefundedPayload = {
      paymentId: payload.paymentId,
      orderId: payload.orderId,
      eventId: payload.eventId,
      seatIds: refundedSeats.map((seat) => seat.seatId),
      amountCents,
    };
    await insertOutboxEvent(client, {
      eventId: payload.eventId,
      type: OUTBOX_EVENT_TYPES.ORDER_SEAT_REFUNDED,
      payload: seatRefundedPayload,
    });
  });
}
