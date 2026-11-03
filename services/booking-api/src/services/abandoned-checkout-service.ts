/**
 * Övergivna betalningar (docs/plan.md "Betalning"). Gick kunden till Stripe och kom tillbaka utan att
 * betala står reservationen kvar i `pending_payment` och blockerar en ny bokning i upp till
 * `payment_frozen_until`. Bara en uttrycklig avbokning (`DELETE`: avbrytsidan, "Tillbaka"/"Avbryt" och
 * kartan som släpper flikens senaste reservation) släpper den. En ny reservation (`POST`) rör aldrig en
 * betalning, så en flik som betalar kan inte förlora sin session för att en annan flik väljer stolar.
 *
 * Stolarna släpps bara när Stripe själv bekräftat att sessionen gått ut: en utgången session kan aldrig
 * betalas, så ingen betalning kan landa efter att stolarna släppts. Är sessionen betald svarar vi 409;
 * går Stripe inte att nå svarar vi 503 och lämnar allt orört.
 */
import {
  getPoolForEvent,
  isDeadlockDetected,
  isLockNotAvailable,
  withTransaction,
  type ShardPools,
} from '@tickets/db';
import {
  ActiveReservationExistsError,
  PaymentProviderUnavailableError,
  SeatUnavailableError,
} from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import type Stripe from 'stripe';
import {
  findPendingPaymentReservationId,
  findPendingStripeSessionId,
  releasePendingPaymentReservation,
} from '../repositories/abandoned-checkout-repository.js';
import { cancelReservation } from './reservation-service.js';
import { deriveOrderId } from './request-hash.js';

export interface AbandonedCheckoutDeps {
  readonly shardPools: ShardPools;
  readonly stripe: Stripe;
  readonly logger: Logger;
}

type SessionState = 'expired' | 'complete' | 'unknown';

const RELEASE_ATTEMPTS = 3;
// Kunden väntar på svaret (avbrytsidan): hellre ett snabbt 503 än SDK:ns standard på 80 s per anrop.
const STRIPE_REQUEST_OPTIONS: Stripe.RequestOptions = { timeout: 5000, maxNetworkRetries: 1 };

/** Låter sessionen gå ut hos Stripe och svarar med hur det gick. Bara `expired` får släppa stolarna. */
async function expireStripeSession(
  deps: AbandonedCheckoutDeps,
  sessionId: string,
): Promise<SessionState> {
  try {
    const session = await deps.stripe.checkout.sessions.expire(
      sessionId,
      {},
      STRIPE_REQUEST_OPTIONS,
    );
    if (session.status === 'expired') {
      return 'expired';
    }
  } catch (error) {
    // Väntat när sessionen redan gått ut (ett tidigare försök) eller redan är betald: läget avgör.
    deps.logger.info(
      { err: error, sessionId },
      'stripe session expire failed, reading its status',
    );
  }
  try {
    const session = await deps.stripe.checkout.sessions.retrieve(
      sessionId,
      {},
      STRIPE_REQUEST_OPTIONS,
    );
    if (session.status === 'expired') {
      return 'expired';
    }
    return session.status === 'complete' ? 'complete' : 'unknown';
  } catch (error) {
    deps.logger.warn({ err: error, sessionId }, 'stripe session status could not be read');
    return 'unknown';
  }
}

async function releaseWithRetries(
  shardPools: ShardPools,
  eventId: string,
  reservationId: string,
): Promise<void> {
  const pool = getPoolForEvent(shardPools, eventId);
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
    try {
      await withTransaction(pool, (client) =>
        releasePendingPaymentReservation(client, eventId, reservationId),
      );
      return;
    } catch (error) {
      if (!isLockNotAvailable(error) && !isDeadlockDetected(error)) {
        throw error;
      }
      if (attempt === RELEASE_ATTEMPTS) {
        throw new SeatUnavailableError([]);
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** Släpper kötokenens övergivna betalning med just det id:t. Ingen betalning = inget att göra. */
async function releaseAbandonedCheckout(
  deps: AbandonedCheckoutDeps,
  eventId: string,
  queueTokenId: string,
  reservationId: string,
): Promise<void> {
  const pool = getPoolForEvent(deps.shardPools, eventId);
  const pendingId = await findPendingPaymentReservationId(
    pool,
    eventId,
    queueTokenId,
    reservationId,
  );
  if (pendingId === undefined) {
    return;
  }
  const sessionId = await findPendingStripeSessionId(pool, eventId, deriveOrderId(pendingId));
  // Checkout skriver betalningsraden i samma transaktion som frysningen, så den ska alltid finnas.
  const state =
    sessionId === undefined ? 'unknown' : await expireStripeSession(deps, sessionId);
  if (state === 'complete') {
    throw new ActiveReservationExistsError(queueTokenId);
  }
  if (state === 'unknown') {
    throw new PaymentProviderUnavailableError({ reservationId: pendingId });
  }
  await releaseWithRetries(deps.shardPools, eventId, pendingId);
}

/**
 * `DELETE /reservations/:id`: avbryter den aktiva reservationen, eller samma reservation om den gått
 * vidare till Stripe utan att betalas. Idempotent: 204 även när det inte finns något att avbryta.
 * 409 om betalningen redan gått igenom, 503 om Stripe inte kunde svara.
 */
export async function cancelReservationOrCheckout(
  deps: AbandonedCheckoutDeps,
  eventId: string,
  reservationId: string,
  queueTokenId: string,
): Promise<void> {
  await cancelReservation(deps.shardPools, eventId, reservationId, queueTokenId);
  await releaseAbandonedCheckout(deps, eventId, queueTokenId, reservationId);
}
