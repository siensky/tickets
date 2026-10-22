/**
 * Auth0-inloggning (docs/plan.md "Auth": "Inloggning krävs först vid
 * betalning, efter reservation"). Enbart checkout-vägen kräver detta —
 * reservationsvägen körs anonymt, autentiserad bara av kötokenen.
 *
 * Auth0 lägger INTE in `email` i en access token som standard (det är
 * en ID-token-claim, och den här koden läser access-tokenet ur
 * `Authorization`-headern) — en namespaced custom claim från en Auth0
 * Action krävs. Se docs/runbook.md "Auth0: e-post-claim på access token"
 * för Action-koden. Läser BÅDA formerna så att en vanlig `email`-claim
 * (t.ex. i tester, eller om tenanten ändå råkar inkludera den) också
 * fungerar utan att en extra /userinfo-rundtripp behövs i
 * checkout-kritisk väg.
 */
import { UnauthorizedError } from '@tickets/domain';
import type { Auth0Verifier } from '@tickets/auth';
import type { JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import { readRequiredHeader } from './http-headers.js';

const AUTHORIZATION_HEADER = 'authorization';
const BEARER_PREFIX = 'Bearer ';
const EMAIL_CLAIM_NAMESPACE = 'https://tickets.app/email';

function readEmailClaim(payload: JWTPayload): string | undefined {
  const direct = payload['email'];
  if (typeof direct === 'string') {
    return direct;
  }
  const namespaced = (payload as Record<string, unknown>)[EMAIL_CLAIM_NAMESPACE];
  return typeof namespaced === 'string' ? namespaced : undefined;
}

function readBearerToken(request: FastifyRequest): string {
  const header = readRequiredHeader(request, AUTHORIZATION_HEADER, () => {
    throw new UnauthorizedError('missing Authorization bearer token');
  });
  if (!header.startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError('Authorization header is not a Bearer token');
  }
  return header.slice(BEARER_PREFIX.length);
}

export function createRequireAuth0User(verifier: Auth0Verifier) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = readBearerToken(request);
    const result = await verifier.verify(token);
    if (result.kind === 'invalid') {
      throw new UnauthorizedError(result.reason);
    }
    const { sub, name } = result.payload;
    const email = readEmailClaim(result.payload);
    if (typeof sub !== 'string' || email === undefined) {
      throw new UnauthorizedError('Auth0 token is missing sub or email claim');
    }
    request.auth0User = {
      auth0Sub: sub,
      email,
      name: typeof name === 'string' ? name : undefined,
    };
  };
}
