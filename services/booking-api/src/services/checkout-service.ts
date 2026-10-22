/**
 * Checkout-skapandet (docs/plan.md "Betalning"): beräknar priset från
 * databasen, loggar in användaren (Auth0-upsert), fryser reservationen,
 * och skapar en Stripe Checkout-session. Samma idempotens-mönster som
 * reservation-service.ts (claim → gör jobbet → complete), men Stripe-
 * anropet ligger UTANFÖR databastransaktionen — en extern HTTP-anrop
 * får aldrig hålla en Postgres-transaktion (och dess låsta rader) öppen.
 *
 * En förlorad TOCTOU-race (reservationen hinner bli `pending_payment`
 * av någon annan MELLAN kontrollen och Stripe-anropet) lämnar en
 * övergiven Stripe-session utan motsvarande order — ofarligt (Stripe
 * tar inte betalt för att skapa en session, och den går ut av sig
 * själv), och `markReservationPendingPayment`s egen villkorade UPDATE
 * är den SKARPA spärren mot "en aktiv Checkout per kötoken".
 */
import { getGlobalPool, getPoolForEvent, withTransaction, type ShardPools } from '@tickets/db';
import {
  IdempotencyConflictError,
  NotFoundError,
  ReservationNotInExpectedStatusError,
} from '@tickets/domain';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  deleteIdempotencyKey,
} from '../repositories/idempotency-repository.js';
import { insertPendingOrder } from '../repositories/orders-repository.js';
import { insertPendingPayment } from '../repositories/payments-repository.js';
import {
  getReservationStatus,
  getReservationWithSeats,
  getSeatPricesForReservation,
  markReservationPendingPayment,
} from '../repositories/reservation-repository.js';
import { ensureUser } from '../repositories/users-repository.js';
import { parseReplayedCheckoutResult } from '../mappers/payment-mapper.js';
import { computeCheckoutRequestHash, deriveOrderId } from './request-hash.js';
import type { CreateCheckoutInput, CreateCheckoutResult } from '../types/payment.js';

const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SCOPE_PREFIX = 'checkout';

export interface CheckoutServiceDeps {
  readonly shardPools: ShardPools;
  readonly stripe: Stripe;
  readonly paymentFrozenMinutes: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export async function createCheckout(
  deps: CheckoutServiceDeps,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const pool = getPoolForEvent(deps.shardPools, input.eventId);
  const idempotencyScope = {
    eventId: input.eventId,
    scope: `${IDEMPOTENCY_SCOPE_PREFIX}:${input.queueTokenId}`,
    key: input.idempotencyKey,
  };
  const requestHash = computeCheckoutRequestHash(input);

  const claim = await claimIdempotencyKey(pool, {
    ...idempotencyScope,
    requestHash,
    ttlMs: IDEMPOTENCY_KEY_TTL_MS,
  });
  if (claim.kind === 'in_flight' || claim.kind === 'hash_mismatch') {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
  if (claim.kind === 'completed') {
    return parseReplayedCheckoutResult(claim.responseBody);
  }

  let result: CreateCheckoutResult;
  try {
    result = await runCheckout(deps, pool, input);
  } catch (error) {
    await deleteIdempotencyKey(pool, idempotencyScope);
    throw error;
  }
  await completeIdempotencyKey(pool, { ...idempotencyScope, responseBody: result });
  return result;
}

/**
 * Genereras deterministiskt av reservationId (inte randomUUID()):
 * annars skickar en retry av SAMMA checkout (efter ett transient fel)
 * ett annat metadata.orderId med den oförändrade Stripe-idempotencyKey:en,
 * och Stripe svarar 400 "samma nyckel, andra parametrar" i 24 timmar.
 * Orderns ID måste finnas INNAN Stripe-anropet, så det kan läggas i
 * sessionens `metadata` (se orders-repository.ts).
 */
async function createStripeCheckoutSession(
  deps: CheckoutServiceDeps,
  input: CreateCheckoutInput,
  orderId: string,
  totalCents: number,
): Promise<Stripe.Checkout.Session> {
  // Egen, scopead idempotencyKey mot Stripe — klientens `input.idempotencyKey`
  // är bara unik inom VÅR idempotency_keys-tabell (scopead på event+kötoken),
  // men Stripes idempotency är global för hela kontot. Två olika användare
  // som råkar skicka samma klientnyckel ska inte krocka där.
  const stripeIdempotencyKey = `checkout:${input.eventId}:${input.reservationId}`;
  // Stripes minimum för `expires_at` är 30 min — längre än frysningens
  // eget tak (`paymentFrozenMinutes`, typiskt 10 min). Frysningen (och
  // dess automatiska återbetalning) är den SKARPA gränsen; det här är
  // bara en backstop så en övergiven session inte kan betalas 24h senare.
  const sessionExpiresAtSeconds =
    Math.floor(Date.now() / 1000) + Math.max(30, deps.paymentFrozenMinutes) * 60;
  return deps.stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'sek',
            unit_amount: totalCents,
            product_data: { name: 'Biljetter' },
          },
          quantity: 1,
        },
      ],
      customer_email: input.email,
      success_url: deps.successUrl,
      cancel_url: deps.cancelUrl,
      expires_at: sessionExpiresAtSeconds,
      metadata: { orderId, eventId: input.eventId, reservationId: input.reservationId },
    },
    { idempotencyKey: stripeIdempotencyKey },
  );
}

async function runCheckout(
  deps: CheckoutServiceDeps,
  pool: Pool,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const reservation = await getReservationWithSeats(pool, input.eventId, input.reservationId);
  if (reservation === undefined || reservation.queueTokenId !== input.queueTokenId) {
    throw new NotFoundError(`Reservation ${input.reservationId} not found`, {
      reservationId: input.reservationId,
    });
  }
  if (reservation.status !== 'active') {
    throw new ReservationNotInExpectedStatusError(
      input.reservationId,
      'active',
      reservation.status,
    );
  }

  const seatPrices = await getSeatPricesForReservation(
    pool,
    input.eventId,
    input.reservationId,
  );
  const totalCents = seatPrices.reduce((sum, seat) => sum + seat.priceCents, 0);
  const user = await ensureUser(getGlobalPool(deps.shardPools), {
    auth0Sub: input.auth0Sub,
    email: input.email,
    name: input.name,
  });

  const orderId = deriveOrderId(input.reservationId);
  const session = await createStripeCheckoutSession(deps, input, orderId, totalCents);

  return withTransaction(pool, (client) =>
    persistCheckout(client, deps, {
      input,
      orderId,
      userId: user.id,
      totalCents,
      sessionId: session.id,
      checkoutUrl: session.url,
    }),
  );
}

async function persistCheckout(
  client: PoolClient,
  deps: CheckoutServiceDeps,
  params: {
    input: CreateCheckoutInput;
    orderId: string;
    userId: string;
    totalCents: number;
    sessionId: string;
    checkoutUrl: string | null;
  },
): Promise<CreateCheckoutResult> {
  const { input } = params;
  const order = await insertPendingOrder(client, {
    id: params.orderId,
    eventId: input.eventId,
    userId: params.userId,
    reservationId: input.reservationId,
    totalCents: params.totalCents,
  });
  await insertPendingPayment(client, {
    eventId: input.eventId,
    orderId: order.id,
    provider: 'stripe',
    providerRef: params.sessionId,
    idempotencyKey: input.idempotencyKey,
    amountCents: params.totalCents,
  });
  const frozen = await markReservationPendingPayment(
    client,
    input.eventId,
    input.reservationId,
    deps.paymentFrozenMinutes,
  );
  if (!frozen) {
    const actualStatus = await getReservationStatus(
      client,
      input.eventId,
      input.reservationId,
    );
    throw new ReservationNotInExpectedStatusError(
      input.reservationId,
      'active',
      actualStatus ?? 'not_found',
    );
  }
  if (params.checkoutUrl === null) {
    throw new Error('Stripe did not return a Checkout URL for a session we just created');
  }
  return { orderId: order.id, checkoutUrl: params.checkoutUrl };
}
