/**
 * Access token via password grant mot en EGEN Auth0-applikation, "CI System
 * Tests" (docs/plan.md 7.14, 7.17), aldrig produktionens SPA-app. Tokens
 * cachas per användare under körningen.
 */
import { authEnv, userCredentials } from './env.js';
import { asRecord, str } from './json.js';

const tokens = new Map<1 | 2, string>();

export async function getAccessToken(which: 1 | 2): Promise<string> {
  const cached = tokens.get(which);
  if (cached !== undefined) {
    return cached;
  }
  const auth = authEnv();
  const credentials = userCredentials(which);
  const response = await fetch(`https://${auth.domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: credentials.email,
      password: credentials.password,
      audience: auth.audience,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      scope: 'openid profile email',
    }),
  });
  if (!response.ok) {
    // Auth0:s felkod och beskrivning (aldrig hemligheter) gör att en felkonfigurerad app syns direkt.
    const body: unknown = await response.json().catch(() => ({}));
    const fields = asRecord(body);
    const detail = [fields['error'], fields['error_description']]
      .filter((value) => typeof value === 'string')
      .join(': ');
    throw new Error(`Auth0 password grant failed with ${String(response.status)}: ${detail}`);
  }
  const token = str(asRecord(await response.json()), 'access_token');
  tokens.set(which, token);
  return token;
}
