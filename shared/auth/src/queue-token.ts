/**
 * Kötoken: signerad, stateless (docs/plan.md "Väntrum"): "HMAC/JWT med
 * `queue_token_id` + `exp`. Signaturen ensam räcker för validering i
 * API-lagret." `exp` är sessionens HÅRDA 15-minuterstak, satt en gång
 * vid utfärdande — token signeras aldrig om, så den begränsningen kan
 * inte kringgås genom att hålla token länge (till skillnad från
 * `admitted:*`-nyckelns inaktivitetsfönster i @tickets/redis, som
 * FÅR förnyas).
 *
 * `sub` bär `queueTokenId` (JWT:s egna "ägare av detta token"-claim,
 * samma roll som i Auth0-token) — inget skäl att hitta på ett eget
 * fält för samma sak.
 */
import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

const ALGORITHM = 'HS256';

export function createQueueTokenSecret(rawSecret: string): Uint8Array {
  return new TextEncoder().encode(rawSecret);
}

export interface IssuedQueueToken {
  readonly token: string;
  readonly queueTokenId: string;
  readonly expiresAt: Date;
}

export async function issueQueueToken(
  secret: Uint8Array,
  eventId: string,
  ttlSeconds: number,
): Promise<IssuedQueueToken> {
  const queueTokenId = randomUUID();
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAtSeconds + ttlSeconds;

  const token = await new SignJWT({ eventId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(queueTokenId)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(secret);

  return { token, queueTokenId, expiresAt: new Date(expiresAtSeconds * 1000) };
}

export type QueueTokenVerificationResult =
  | { readonly kind: 'valid'; readonly queueTokenId: string; readonly eventId: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export async function verifyQueueToken(
  secret: Uint8Array,
  token: string,
): Promise<QueueTokenVerificationResult> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALGORITHM] });
    const { sub: queueTokenId, eventId } = payload;
    if (typeof queueTokenId !== 'string' || typeof eventId !== 'string') {
      return { kind: 'invalid', reason: 'token is missing queueTokenId or eventId claim' };
    }
    return { kind: 'valid', queueTokenId, eventId };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}
