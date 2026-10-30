/**
 * Miljön systemtesterna körs mot (docs/plan.md 7.14). Inget default för
 * hemligheter: saknas en variabel fallerar testet direkt och tydligt.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run the system tests`);
  }
  return value;
}

export const API_URL = process.env['SYSTEM_API_URL'] ?? 'http://localhost:3000';
export const DATABASE_URL_SHARD_0 =
  process.env['DATABASE_URL_SHARD_0'] ??
  'postgresql://postgres:postgres@localhost:5432/tickets';
export const DATABASE_URL_SHARD_1 =
  process.env['DATABASE_URL_SHARD_1'] ??
  'postgresql://postgres:postgres@localhost:5452/tickets';

export function authEnv(): {
  domain: string;
  audience: string;
  clientId: string;
  clientSecret: string;
} {
  return {
    domain: required('AUTH0_DOMAIN'),
    audience: required('AUTH0_AUDIENCE'),
    clientId: required('AUTH0_CI_CLIENT_ID'),
    clientSecret: required('AUTH0_CI_CLIENT_SECRET'),
  };
}

export function userCredentials(which: 1 | 2): { email: string; password: string } {
  return which === 1
    ? {
        email: required('AUTH0_TEST_USER_EMAIL'),
        password: required('AUTH0_TEST_USER_PASSWORD'),
      }
    : {
        email: required('SYSTEMTEST_USER2_EMAIL'),
        password: required('SYSTEMTEST_USER2_PASSWORD'),
      };
}
