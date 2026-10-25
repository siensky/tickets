/**
 * Konsumerar `order.confirmed` och `order.refunded` (docs/plan.md
 * "Tjänster": notification-worker). Dedupe på Redis-set med TTL, inte
 * `processed_messages` (docs/plan.md "Idempotens"-tabellen: pengar/
 * biljetter får den durabla databastabellen eftersom en förlorad
 * dubblett där är farlig; ett dubbelt mejl här är bara irriterande,
 * inte farligt, så en TTL-skyddad Redis-nyckel räcker).
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { claimNotification, releaseNotificationClaim, type RedisClient } from '@tickets/redis';
import type { Logger } from '@tickets/observability';
import { getOrderUserId } from '../repositories/orders-repository.js';
import { getUserEmail } from '../repositories/users-repository.js';
import {
  sendOrderConfirmationEmail,
  sendRefundEmail,
  sendSeatRefundEmail,
} from './email-service.js';

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export interface NotificationConsumerDeps {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly logger: Logger;
}

interface OrderConfirmedPayloadShape {
  readonly orderId: string;
  readonly eventId: string;
  readonly userId: string;
  readonly ticketIds: readonly string[];
}

interface OrderRefundedPayloadShape {
  readonly orderId: string;
  readonly eventId: string;
  readonly paymentId: string;
  readonly reservationId: string;
}

interface OrderSeatRefundedPayloadShape {
  readonly orderId: string;
  readonly eventId: string;
  readonly paymentId: string;
  readonly seatIds: readonly string[];
  readonly amountCents: number;
}

function isOrderConfirmedPayload(payload: unknown): payload is OrderConfirmedPayloadShape {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'ticketIds' in payload &&
    Array.isArray(payload.ticketIds)
  );
}

// Checked BEFORE isOrderRefundedPayload — both shapes carry `paymentId` and
// neither carries `ticketIds`, so `seatIds` is what actually tells them
// apart (docs/plan.md "Oversell": a partial seat refund is NOT the same
// customer message as the whole order being refunded).
function isOrderSeatRefundedPayload(
  payload: unknown,
): payload is OrderSeatRefundedPayloadShape {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'seatIds' in payload &&
    Array.isArray(payload.seatIds)
  );
}

function isOrderRefundedPayload(payload: unknown): payload is OrderRefundedPayloadShape {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'paymentId' in payload &&
    !('ticketIds' in payload) &&
    !('seatIds' in payload)
  );
}

async function handleOrderConfirmed(
  deps: NotificationConsumerDeps,
  payload: OrderConfirmedPayloadShape,
): Promise<void> {
  const email = await getUserEmail(getGlobalPool(deps.shardPools), payload.userId);
  if (email === undefined) {
    deps.logger.warn(
      { userId: payload.userId, orderId: payload.orderId },
      'no user found for order.confirmed',
    );
    return;
  }
  sendOrderConfirmationEmail(deps.logger, {
    email,
    orderId: payload.orderId,
    ticketIds: payload.ticketIds,
  });
}

async function handleOrderRefunded(
  deps: NotificationConsumerDeps,
  payload: OrderRefundedPayloadShape,
): Promise<void> {
  const userId = await getOrderUserId(
    getPoolForEvent(deps.shardPools, payload.eventId),
    payload.eventId,
    payload.orderId,
  );
  if (userId === undefined) {
    deps.logger.warn({ orderId: payload.orderId }, 'no order found for order.refunded');
    return;
  }
  const email = await getUserEmail(getGlobalPool(deps.shardPools), userId);
  if (email === undefined) {
    deps.logger.warn({ userId, orderId: payload.orderId }, 'no user found for order.refunded');
    return;
  }
  sendRefundEmail(deps.logger, { email, orderId: payload.orderId });
}

async function handleOrderSeatRefunded(
  deps: NotificationConsumerDeps,
  payload: OrderSeatRefundedPayloadShape,
): Promise<void> {
  const userId = await getOrderUserId(
    getPoolForEvent(deps.shardPools, payload.eventId),
    payload.eventId,
    payload.orderId,
  );
  if (userId === undefined) {
    deps.logger.warn({ orderId: payload.orderId }, 'no order found for order.seat_refunded');
    return;
  }
  const email = await getUserEmail(getGlobalPool(deps.shardPools), userId);
  if (email === undefined) {
    deps.logger.warn(
      { userId, orderId: payload.orderId },
      'no user found for order.seat_refunded',
    );
    return;
  }
  sendSeatRefundEmail(deps.logger, {
    email,
    orderId: payload.orderId,
    seatIds: payload.seatIds,
    amountCents: payload.amountCents,
  });
}

export async function processNotificationEvent(
  deps: NotificationConsumerDeps,
  payload: unknown,
  messageId: string | undefined,
): Promise<void> {
  if (messageId === undefined) {
    throw new Error('notification event is missing its messageId');
  }
  const isNew = await claimNotification(deps.redis, messageId, DEDUPE_TTL_SECONDS);
  if (!isNew) {
    return;
  }

  // Claimen tas INNAN jobbet görs (så två samtidiga leveranser av samma
  // meddelande-id inte båda skickar mejlet) — men misslyckas jobbet
  // efteråt (databasfel, mejlfel) måste claimen släppas, annars dedupas
  // en legitim redelivery mot den redan satta nyckeln och notisen
  // uteblir för gott.
  try {
    if (isOrderConfirmedPayload(payload)) {
      await handleOrderConfirmed(deps, payload);
      return;
    }
    if (isOrderSeatRefundedPayload(payload)) {
      await handleOrderSeatRefunded(deps, payload);
      return;
    }
    if (isOrderRefundedPayload(payload)) {
      await handleOrderRefunded(deps, payload);
      return;
    }
    deps.logger.warn({ payload }, 'unrecognized notification event payload, ignoring');
  } catch (error) {
    await releaseNotificationClaim(deps.redis, messageId);
    throw error;
  }
}
