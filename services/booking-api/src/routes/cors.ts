/**
 * CORS (docs/plan.md "Klienter": appen körs på `<domän>`, API:et på
 * `api.<domän>` — alltid en annan origin, så webbläsaren blockerar varje
 * svar utan explicita CORS-headers, inklusive preflighten för alla
 * requests som bär `X-Queue-Token`/`Idempotency-Key`/`Authorization`).
 *
 * Ingen `credentials: true`: systemet skickar aldrig cookies för
 * autentisering, bara explicita headers (docs/rules.md §6) — det gör
 * en statisk origin-allowlist tillräcklig, utan ett eget
 * cookie-läckage att skydda mot.
 */
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

const ALLOWED_HEADERS = ['content-type', 'authorization', 'x-queue-token', 'idempotency-key'];
const ALLOWED_METHODS = ['GET', 'POST', 'DELETE'];
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5173';

function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_ALLOWED_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function registerCors(app: FastifyInstance): void {
  void app.register(cors, {
    origin: parseAllowedOrigins(process.env['CORS_ALLOWED_ORIGINS']),
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
  });
}
