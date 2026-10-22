/**
 * Signerar en webhook-payload med SAMMA format Stripe använder
 * (`t=<timestamp>,v1=<hmac>`) — booking-apis webhook-handler verifierar
 * med `stripe.webhooks.constructEvent`, som förväntar exakt detta
 * format oavsett om avsändaren är riktiga Stripe eller denna mock
 * (docs/plan.md "payment-mock för lasttest": samma klientkod, bara
 * motparten byts). Ingen `stripe`-SDK behövs här — det här är bara en
 * HMAC-SHA256, inget API-anrop.
 */
import { createHmac } from 'node:crypto';

export function signWebhookPayload(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
