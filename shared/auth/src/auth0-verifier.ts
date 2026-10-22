/**
 * Auth0 JWT-verifiering mot deras publika JWKS (docs/plan.md "Auth":
 * "OAuth2 via Auth0 gratisnivå"). `createRemoteJWKSet` cachar och
 * roterar nycklarna själv — ingen egen JWKS-cache behövs.
 *
 * Algoritmen är LÅST till RS256 (docs/rules.md §6: "verifiera mot
 * Auth0:s JWKS, lås algoritmen") — utan det kunde ett token med
 * `alg: "none"` eller ett HMAC-härmat RS256-token (alg confusion)
 * passera om någon lager längre upp råkar lita på headerns egen
 * algoritm-uppgift.
 *
 * Returnerar ett resultat i stället för att kasta ett domänfel — detta
 * paket importerar avsiktligt inte @tickets/domain (docs/rules.md §1:
 * delade paket är oberoende av varandra, se @tickets/rabbit:s egen
 * kommentar om samma princip). Anroparen mappar `invalid` till
 * `QueueTokenInvalidError`/`UnauthorizedError` själv.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface Auth0VerifierOptions {
  readonly domain: string;
  readonly audience: string;
}

export type Auth0VerificationResult =
  | { readonly kind: 'valid'; readonly payload: JWTPayload }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface Auth0Verifier {
  verify(token: string): Promise<Auth0VerificationResult>;
}

export interface JwksVerifierOptions {
  readonly jwksUrl: URL;
  readonly issuer: string;
  readonly audience: string;
}

/**
 * Lägre nivå: tar emot en redan uppbyggd JWKS-URL + issuer, i stället
 * för att själv härleda dem från en Auth0-domän. `createAuth0Verifier`
 * nedan är den enda formen produktionskoden använder (alltid `https://`
 * mot en riktig Auth0-tenant) — den här finns för att testsviten ska
 * kunna peka på en lokal http://-JWKS-server utan ett riktigt
 * Auth0-konto.
 */
export function createJwksVerifier(options: JwksVerifierOptions): Auth0Verifier {
  const jwks = createRemoteJWKSet(options.jwksUrl);

  return {
    async verify(token: string): Promise<Auth0VerificationResult> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ['RS256'],
        });
        return { kind: 'valid', payload };
      } catch (error) {
        return {
          kind: 'invalid',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createAuth0Verifier(options: Auth0VerifierOptions): Auth0Verifier {
  const issuer = `https://${options.domain}/`;
  return createJwksVerifier({
    jwksUrl: new URL(`${issuer}.well-known/jwks.json`),
    issuer,
    audience: options.audience,
  });
}
