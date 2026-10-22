/**
 * All SQL for `payments` (docs/plan.md "Databas"/"Betalning"). One row
 * per Checkout attempt, created `pending` at checkout time, flipped to
 * `succeeded` or `refunded` by the payment-succeeded consumer — never
 * updated synchronously from the webhook handler itself.
 */
import type { Pool, PoolClient } from 'pg';
import type { InsertedPayment, PaymentRow } from '../types/payment.js';

export async function insertPendingPayment(
  client: PoolClient,
  params: {
    eventId: string;
    orderId: string;
    provider: string;
    providerRef: string;
    idempotencyKey: string;
    amountCents: number;
  },
): Promise<InsertedPayment> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payments (event_id, order_id, provider, provider_ref, idempotency_key, amount_cents, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [
      params.eventId,
      params.orderId,
      params.provider,
      params.providerRef,
      params.idempotencyKey,
      params.amountCents,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertPendingPayment: INSERT ... RETURNING produced no row');
  }
  return { id: row.id };
}

export async function getPaymentByProviderRef(
  client: PoolClient,
  eventId: string,
  providerRef: string,
): Promise<PaymentRow | undefined> {
  const { rows } = await client.query<{
    id: string;
    event_id: string;
    order_id: string;
    provider_ref: string;
    status: string;
  }>(
    'SELECT id, event_id, order_id, provider_ref, status FROM payments WHERE event_id = $1 AND provider_ref = $2',
    [eventId, providerRef],
  );
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    eventId: row.event_id,
    orderId: row.order_id,
    providerRef: row.provider_ref,
    status: row.status,
  };
}

/**
 * `provider_charge_ref` (the PaymentIntent id) is only known once the
 * webhook arrives — see shared/db/migrations/sharded/..._add-payments-
 * provider-charge-ref.ts for why it isn't set at checkout time.
 */
export async function markPaymentSucceeded(
  client: PoolClient,
  eventId: string,
  paymentId: string,
  providerChargeRef: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE payments SET status = 'succeeded', provider_charge_ref = $3
     WHERE event_id = $1 AND id = $2 AND status = 'pending'`,
    [eventId, paymentId, providerChargeRef],
  );
  return rowCount === 1;
}

/**
 * Läsning av statusen ensam (ingen transaktion) — använd för att avgöra
 * om en redelivered `payment.succeeded` fortfarande har ett oavslutat
 * `refund_needed`-fall att göra klart (se payment-consumer-service.ts).
 */
export async function getPaymentStatusById(
  pool: Pool,
  eventId: string,
  paymentId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM payments WHERE event_id = $1 AND id = $2',
    [eventId, paymentId],
  );
  return rows[0]?.status;
}

export async function markPaymentStatus(
  client: PoolClient,
  eventId: string,
  paymentId: string,
  fromStatus: string,
  toStatus: string,
  rawResponse?: unknown,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE payments SET status = $4, raw_response = COALESCE($5, raw_response)
     WHERE event_id = $1 AND id = $2 AND status = $3`,
    [
      eventId,
      paymentId,
      fromStatus,
      toStatus,
      rawResponse !== undefined ? JSON.stringify(rawResponse) : null,
    ],
  );
  return rowCount === 1;
}
