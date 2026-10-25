/**
 * Konsumerar `payment.succeeded` (docs/plan.md "Betalning"): konverterar
 * reservationen och myntar biljetter — ELLER, om frysningen redan
 * hunnit gå ut och stolarna tagits över av någon annan, återbetalar
 * automatiskt ("Betalning som landar efter utgången reservation": "Två
 * mekanismer, inte en"). Körs i booking-api, inte i notification-worker
 * eller scheduler-worker — se docs/forsvar.md för avvägningen.
 *
 * Biljettmyntning, reservationskonvertering OCH outbox-skrivningen körs
 * i SAMMA transaktion som dedupe-claimen (`processed_messages`) — annars
 * är det transaktionella outbox-mönstret poänglöst: en process som
 * kraschar MELLAN två separata transaktioner skulle kunna mynta
 * biljetter utan att någonsin skriva händelsen som får
 * notification-worker att skicka bekräftelsemejlet.
 */
import {
  getPoolForEvent,
  isUniqueViolation,
  withTransaction,
  type ShardPools,
} from '@tickets/db';
import {
  InternalError,
  OUTBOX_EVENT_TYPES,
  type OrderConfirmedPayload,
  type PaymentSucceededPayload,
} from '@tickets/domain';
import type { Logger, OversellMetrics } from '@tickets/observability';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import { insertOutboxEvent } from '../repositories/outbox-repository.js';
import { getOrderForPayment, markOrderStatus } from '../repositories/orders-repository.js';
import {
  getPaymentStatusById,
  markPaymentSucceeded,
  markPaymentStatus,
} from '../repositories/payments-repository.js';
import { claimProcessedMessage } from '../repositories/processed-messages-repository.js';
import {
  getSeatPricesForReservation,
  markReservationConverted,
  markSeatsSold,
  releaseConflictedSeat,
} from '../repositories/reservation-repository.js';
import { getTicketedSeatIds, insertTicket } from '../repositories/tickets-repository.js';
import { createQrToken } from './qr-token.js';
import {
  refundAndNotify,
  refundSeatsAndNotify,
  type RefundedSeat,
} from './payment-refund-service.js';

const CONSUMER_NAME = 'booking-api.payment-succeeded';

// shared/db/migrations/sharded/1700000008000_create-tickets.ts — partial unique index
// name, scoped to status = 'valid'.
const TICKETS_VALID_SEAT_CONSTRAINT = 'tickets_valid_seat_unique';

export interface PaymentConsumerDeps {
  readonly shardPools: ShardPools;
  readonly stripe: Stripe;
  readonly qrTokenSecret: string;
  readonly logger: Logger;
  readonly oversellMetrics: OversellMetrics;
}

/**
 * The RabbitMQ consumer base (@tickets/rabbit) hands handlers an
 * `unknown` payload — it crossed a JSON (de)serialization boundary, so
 * it gets the same "never trust it blindly" treatment as any other
 * external input, even though it's our own outbox event.
 */
export function parsePaymentSucceededPayload(payload: unknown): PaymentSucceededPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new InternalError('payment.succeeded payload is not an object', { payload });
  }
  // Redan kontrollerat att det är ett icke-null objekt ovan — castet
  // vidgar bara indexsignaturen så fälten kan läsas ut och valideras
  // ett och ett nedan, det är INTE ett antagande om att formen är rätt.
  const { paymentId, orderId, reservationId, eventId, providerRef, providerChargeRef } =
    payload as Record<string, unknown>;
  if (
    typeof paymentId !== 'string' ||
    typeof orderId !== 'string' ||
    typeof reservationId !== 'string' ||
    typeof eventId !== 'string' ||
    typeof providerRef !== 'string' ||
    typeof providerChargeRef !== 'string'
  ) {
    throw new InternalError('payment.succeeded payload is missing required fields', {
      payload,
    });
  }
  return { paymentId, orderId, reservationId, eventId, providerRef, providerChargeRef };
}

type ProcessOutcome =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refund_needed' }
  | { readonly kind: 'converted'; readonly refundedSeats: readonly RefundedSeat[] };

export async function processPaymentSucceeded(
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
  messageId: string | undefined,
): Promise<void> {
  if (messageId === undefined) {
    throw new InternalError('payment.succeeded message is missing its messageId', { payload });
  }
  const pool = getPoolForEvent(deps.shardPools, payload.eventId);

  const outcome = await withTransaction(pool, (client) =>
    convertReservationOrFlagRefund(client, deps, payload, messageId),
  );
  if (outcome.kind === 'refund_needed') {
    await refundAndNotify(deps.stripe, pool, payload);
    return;
  }
  if (outcome.kind === 'converted') {
    if (outcome.refundedSeats.length > 0) {
      await refundSeatsAndNotify(deps.stripe, pool, payload, outcome.refundedSeats);
    }
    return;
  }
  // kind === 'duplicate': redelivery (requeue efter krasch, eller
  // x-delivery-limit-retry) — dedupe-claimen i den FÖRSTA transaktionen är
  // redan tagen, så vi hamnar aldrig i grenarna ovan igen för det här
  // försöket. Två saker kan fortfarande vara ogjorda från förra försöket,
  // utan att ha lämnat en egen "pending"-markör — båda härleds ur redan
  // skrivet tillstånd i stället:
  const currentStatus = await getPaymentStatusById(pool, payload.eventId, payload.paymentId);
  if (currentStatus === 'refund_needed') {
    // Hela ordern skulle återbetalas (expired reservation) men hann
    // krascha innan Stripe-anropet (docs/plan.md "Betalning som landar
    // efter utgången reservation"). `refundAndNotify` är säker att köra
    // flera gånger (Stripes idempotencyKey + det villkorade UPDATE:et
    // nedan).
    await refundAndNotify(deps.stripe, pool, payload);
    return;
  }
  if (currentStatus === 'succeeded') {
    // Ordern konverterades, men en delvis återbetalning (oversold stol)
    // hann krascha innan Stripe-anropet. Ingen egen "pending"-markör för
    // det heller — vilka stolar som saknar en giltig biljett för den här
    // ordern räknas om från tickets-tabellen, samma härledning som
    // refundSeatsAndNotify redan bygger på.
    const pendingRefund = await getUnticketedReservedSeats(pool, payload);
    if (pendingRefund.length > 0) {
      await refundSeatsAndNotify(deps.stripe, pool, payload, pendingRefund);
    }
  }
}

async function getUnticketedReservedSeats(
  pool: Pool,
  payload: PaymentSucceededPayload,
): Promise<readonly RefundedSeat[]> {
  const seats = await getSeatPricesForReservation(
    pool,
    payload.eventId,
    payload.reservationId,
  );
  if (seats.length === 0) {
    return [];
  }
  const ticketedSeatIds = new Set(
    await getTicketedSeatIds(pool, payload.eventId, payload.orderId),
  );
  return seats.filter((seat) => !ticketedSeatIds.has(seat.seatId));
}

// Varaktigt skrivet i SAMMA transaktion som dedupe-claimen — en krasch
// mellan denna commit och det faktiska Stripe-återbetalningsanropet lämnar
// betalningen synligt fast i "refund_needed", inte tyst förlorad. En
// periodisk sweeper för fastnade rader här är ett rimligt uppföljningssteg,
// inte byggt i den här omgången.
async function flagPaymentForRefund(
  client: PoolClient,
  payload: PaymentSucceededPayload,
): Promise<ProcessOutcome> {
  await markPaymentStatus(
    client,
    payload.eventId,
    payload.paymentId,
    'succeeded',
    'refund_needed',
  );
  return { kind: 'refund_needed' };
}

async function convertReservationOrFlagRefund(
  client: PoolClient,
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
  messageId: string,
): Promise<ProcessOutcome> {
  const claimed = await claimProcessedMessage(client, {
    eventId: payload.eventId,
    messageId,
    consumer: CONSUMER_NAME,
  });
  if (!claimed) {
    return { kind: 'duplicate' };
  }

  const paymentMarked = await markPaymentSucceeded(
    client,
    payload.eventId,
    payload.paymentId,
    payload.providerChargeRef,
  );
  if (!paymentMarked) {
    throw new InternalError(
      'Payment was not in "pending" status when payment.succeeded arrived',
      {
        paymentId: payload.paymentId,
      },
    );
  }

  const converted = await markReservationConverted(
    client,
    payload.eventId,
    payload.reservationId,
  );
  if (!converted) {
    return flagPaymentForRefund(client, payload);
  }

  const { ticketIds, refundedSeats } = await convertOrderAndMintTickets(client, deps, payload);
  if (ticketIds.length === 0) {
    // Every reserved seat lost the tickets_valid_seat_unique race —
    // pathological (a held/pending_payment reservation should make this
    // near-impossible) but handled the same as an expired reservation:
    // nothing to confirm, full refund. convertOrderAndMintTickets did NOT
    // flip the order to "paid" in this case (see its own comment), so it's
    // still "pending" here, exactly what refundAndNotify's cancel expects.
    return flagPaymentForRefund(client, payload);
  }
  return { kind: 'converted', refundedSeats };
}

async function mintTicketsForSeats(
  client: PoolClient,
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
): Promise<{ ticketIds: string[]; refundedSeats: RefundedSeat[] }> {
  const seats = await getSeatPricesForReservation(
    client,
    payload.eventId,
    payload.reservationId,
  );
  await markSeatsSold(client, payload.eventId, payload.reservationId);
  const ticketIds: string[] = [];
  const refundedSeats: RefundedSeat[] = [];
  for (const seat of seats) {
    const qrToken = createQrToken(deps.qrTokenSecret, payload.orderId, seat.seatId);
    // SAVEPOINT: a unique-violation poisons the whole transaction the same
    // way NOWAIT does in reservation-repository.ts's lockSeats — without
    // it, one oversold seat would also undo tickets already minted for
    // this order's OTHER seats, not just skip the one that lost the race.
    await client.query('SAVEPOINT mint_ticket');
    try {
      const ticket = await insertTicket(client, {
        eventId: payload.eventId,
        orderId: payload.orderId,
        seatId: seat.seatId,
        qrToken,
      });
      await client.query('RELEASE SAVEPOINT mint_ticket');
      ticketIds.push(ticket.id);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT mint_ticket');
      if (!isUniqueViolation(error, TICKETS_VALID_SEAT_CONSTRAINT)) {
        throw error;
      }
      // markSeatsSold above already flipped this seat to "sold" under OUR
      // reservation — but we're not minting it a ticket, so leaving it
      // "sold" would strand it, unsellable, under a reservation with
      // nothing to show for it. releaseConflictedSeat no-ops if the seat's
      // already been reassigned to whoever actually holds the valid
      // ticket by the time we get here.
      await releaseConflictedSeat(client, payload.eventId, seat.seatId, payload.reservationId);
      deps.oversellMetrics.oversellPreventedTotal.inc();
      deps.logger.warn(
        { eventId: payload.eventId, orderId: payload.orderId, seatId: seat.seatId },
        'tickets_valid_seat_unique prevented an oversold seat — releasing it and refunding its price',
      );
      refundedSeats.push(seat);
    }
  }
  return { ticketIds, refundedSeats };
}

async function convertOrderAndMintTickets(
  client: PoolClient,
  deps: PaymentConsumerDeps,
  payload: PaymentSucceededPayload,
): Promise<{ ticketIds: string[]; refundedSeats: RefundedSeat[] }> {
  const order = await getOrderForPayment(client, payload.eventId, payload.orderId);
  if (order === undefined) {
    throw new InternalError('Order not found while converting a paid reservation', {
      orderId: payload.orderId,
    });
  }

  const { ticketIds, refundedSeats } = await mintTicketsForSeats(client, deps, payload);
  if (ticketIds.length === 0) {
    // Caller treats this as a full refund — order stays "pending" so its
    // own cancel transition still applies cleanly.
    return { ticketIds, refundedSeats };
  }

  const orderMarked = await markOrderStatus(
    client,
    payload.eventId,
    payload.orderId,
    'pending',
    'paid',
  );
  if (!orderMarked) {
    throw new InternalError('Order was not "pending" when its reservation converted', {
      orderId: payload.orderId,
    });
  }

  const confirmedPayload: OrderConfirmedPayload = {
    orderId: payload.orderId,
    eventId: payload.eventId,
    userId: order.userId,
    ticketIds,
  };
  await insertOutboxEvent(client, {
    eventId: payload.eventId,
    type: OUTBOX_EVENT_TYPES.ORDER_CONFIRMED,
    payload: confirmedPayload,
  });

  return { ticketIds, refundedSeats };
}
