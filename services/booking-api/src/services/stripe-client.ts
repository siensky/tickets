/**
 * Stripe-klienten (docs/plan.md "Betalning": "Stripe testläge för det
 * riktiga flödet"). `host`/`protocol`/`port` är satta för att låta
 * SAMMA klientkod köras mot `payment-mock` under lasttest
 * (docs/plan.md: "payment-mock för lasttest") — SDK:n stöder att peka
 * om sig mot en annan server, så applikationskoden som anropar
 * `stripe.checkout.sessions.create` är identisk oavsett mål.
 */
import Stripe from 'stripe';

export interface StripeClientOptions {
  readonly secretKey: string;
  readonly host?: string;
  readonly protocol?: 'http' | 'https';
  readonly port?: number;
}

export function createStripeClient(options: StripeClientOptions): Stripe {
  return new Stripe(options.secretKey, {
    host: options.host,
    protocol: options.protocol,
    port: options.port,
  });
}
