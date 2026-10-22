/**
 * Kör mot en EGEN, lokal JWKS-server (ingen riktig Auth0-tenant behövs
 * för att testa signaturverifieringslogiken). `createJwksVerifier`
 * (den testbara, lägre nivån av `createAuth0Verifier`) pekas på en
 * http://-server i stället för en riktig https://-Auth0-tenant.
 */
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwksVerifier } from '../auth0-verifier.js';

const JWKS_PATH = '/.well-known/jwks.json';
const AUDIENCE = 'https://api.tickets.test';
const KEY_ID = 'test-key';

interface TestContext {
  jwksUrl: URL;
  issuer: string;
  signToken: (overrides?: {
    audience?: string;
    expSecondsFromNow?: number;
  }) => Promise<string>;
}

async function setUpJwksServer(): Promise<{ server: Server; context: TestContext }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);

  const server = createServer((req, res) => {
    if (req.url === JWKS_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, alg: 'RS256', use: 'sig', kid: KEY_ID }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the test server to bind a TCP port');
  }
  const issuer = `http://127.0.0.1:${address.port}/`;

  const signToken: TestContext['signToken'] = async (overrides = {}) => {
    const exp = Math.floor(Date.now() / 1000) + (overrides.expSecondsFromNow ?? 300);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setSubject('auth0|user-1')
      .setIssuer(issuer)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  };

  return {
    server,
    context: { jwksUrl: new URL(`${issuer}${JWKS_PATH.slice(1)}`), issuer, signToken },
  };
}

describe('createJwksVerifier', () => {
  let server: Server;
  let ctx: TestContext;

  beforeAll(async () => {
    const started = await setUpJwksServer();
    server = started.server;
    ctx = started.context;
  });

  afterAll(() => {
    server.close();
  });

  it('accepts a token signed by the key the JWKS endpoint publishes', async () => {
    const verifier = createJwksVerifier({
      jwksUrl: ctx.jwksUrl,
      issuer: ctx.issuer,
      audience: AUDIENCE,
    });
    const token = await ctx.signToken();

    const result = await verifier.verify(token);

    expect(result.kind).toBe('valid');
  });

  it('rejects a token issued for a different audience', async () => {
    const verifier = createJwksVerifier({
      jwksUrl: ctx.jwksUrl,
      issuer: ctx.issuer,
      audience: AUDIENCE,
    });
    const token = await ctx.signToken({ audience: 'https://someone-else.test' });

    const result = await verifier.verify(token);

    expect(result.kind).toBe('invalid');
  });

  it('rejects an expired token', async () => {
    const verifier = createJwksVerifier({
      jwksUrl: ctx.jwksUrl,
      issuer: ctx.issuer,
      audience: AUDIENCE,
    });
    const token = await ctx.signToken({ expSecondsFromNow: -10 });

    const result = await verifier.verify(token);

    expect(result.kind).toBe('invalid');
  });

  it('rejects garbage input instead of throwing', async () => {
    const verifier = createJwksVerifier({
      jwksUrl: ctx.jwksUrl,
      issuer: ctx.issuer,
      audience: AUDIENCE,
    });

    const result = await verifier.verify('not-a-jwt');

    expect(result.kind).toBe('invalid');
  });
});
