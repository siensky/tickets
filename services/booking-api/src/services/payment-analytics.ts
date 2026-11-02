/**
 * PostHog-händelser från betalningskonsumenten (docs/plan.md 7.7): `payment_succeeded` och
 * `payment_late_refunded`, med köparens Auth0 `sub` som `distinct_id` så att de hamnar i samma
 * tratt som klientens händelser. Kan inte blockeras av en adblocker.
 *
 * Best-effort: analytics får aldrig fälla eller försena betalningshanteringen, så alla fel
 * loggas som varning. Anropas först EFTER att transaktionen committats, och bara från den
 * leverans som faktiskt gjorde jobbet, så en dubbel webhook ger aldrig en andra händelse.
 */
import type { ServerAnalytics } from '@tickets/analytics/server';
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import type { PaymentSucceededPayload } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import { getOrderUserId } from '../repositories/orders-repository.js';
import { getAuth0SubByUserId } from '../repositories/users-repository.js';

export interface PaymentAnalyticsDeps {
  readonly shardPools: ShardPools;
  readonly analytics: ServerAnalytics;
  readonly logger: Logger;
}

async function lookupBuyerSub(
  deps: PaymentAnalyticsDeps,
  userId: string,
): Promise<string | undefined> {
  return getAuth0SubByUserId(getGlobalPool(deps.shardPools), userId);
}

export async function trackPaymentSucceeded(
  deps: PaymentAnalyticsDeps,
  payload: PaymentSucceededPayload,
  conversion: {
    readonly userId: string;
    readonly seatCount: number;
    readonly totalCents: number;
  },
): Promise<void> {
  try {
    const sub = await lookupBuyerSub(deps, conversion.userId);
    if (sub === undefined) {
      return;
    }
    deps.analytics.track(sub, 'payment_succeeded', {
      order_id: payload.orderId,
      event_id: payload.eventId,
      seat_count: conversion.seatCount,
      total_sek: conversion.totalCents / 100,
    });
  } catch (error) {
    deps.logger.warn(
      { error, orderId: payload.orderId },
      'payment_succeeded analytics failed',
    );
  }
}

export async function trackPaymentLateRefunded(
  deps: PaymentAnalyticsDeps,
  payload: PaymentSucceededPayload,
): Promise<void> {
  try {
    const userId = await getOrderUserId(
      getPoolForEvent(deps.shardPools, payload.eventId),
      payload.eventId,
      payload.orderId,
    );
    const sub = userId === undefined ? undefined : await lookupBuyerSub(deps, userId);
    if (sub === undefined) {
      return;
    }
    deps.analytics.track(sub, 'payment_late_refunded', {
      order_id: payload.orderId,
      event_id: payload.eventId,
    });
  } catch (error) {
    deps.logger.warn(
      { error, orderId: payload.orderId },
      'payment_late_refunded analytics failed',
    );
  }
}
