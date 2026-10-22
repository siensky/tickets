/**
 * `payments.provider_charge_ref` — the PaymentIntent id (docs/plan.md
 * "Betalning"). `provider_ref` (set at Checkout time) holds the
 * Checkout SESSION id, which the webhook needs to look the payment row
 * up by — but a refund is issued against the PAYMENT INTENT, not the
 * session, and the session id alone can't be exchanged for it without
 * another Stripe API round-trip. The webhook already receives the
 * PaymentIntent id on `checkout.session.completed` for free, so this
 * column is filled in there instead.
 *
 * Nullable: a payment only has this once its webhook has actually
 * arrived — forward-compatible per docs/rules.md §4.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.addColumn('payments', {
    provider_charge_ref: { type: 'text' },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropColumn('payments', 'provider_charge_ref');
}
