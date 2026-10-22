/**
 * QR-biljettens token (docs/plan.md "Databas": "`qr_token` är en
 * HMAC-SHA256 med serverhemlighet, inte en ren hash. Determinismen ...
 * bevaras, men ingen utan nyckeln kan tillverka en giltig biljett.
 * `order_id` och `seat_id` är inte hemligheter — de syns i API-svar").
 * Determinismen är avsiktlig: körs biljettutfärdandet om (en konsument-
 * redelivery) ger den SAMMA token, så ingen dubblettrad kan smyga sig in
 * via `ON CONFLICT DO NOTHING`-stilen andra engångsjobb redan använder.
 */
import { createHmac } from 'node:crypto';

export function createQrToken(secret: string, orderId: string, seatId: string): string {
  return createHmac('sha256', secret).update(`${orderId}:${seatId}`).digest('hex');
}
