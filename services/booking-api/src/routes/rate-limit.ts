/**
 * Rate limiting per IP (docs/plan.md "Botskydd": "alltid på"). Ett
 * `onRequest`-hook på root-instansen träffar varje route INNAN
 * routingen är klar, så undantaget (Stripe-webhooken, docs/plan.md
 * "Betalning": "Stripe-webhooken undantas från rate limitingen") måste
 * avgöras på den råa URL:en, inte `request.routeOptions` — den är
 * tom så tidigt i livscykeln. Samma skäl att /health/* och /metrics
 * undantas: de kallas av kubelet/Prometheus, inte av en klient man vill
 * begränsa, och livenessProben FÅR bara kontrollera att processen lever
 * (docs/plan.md "Probes") — den ska aldrig kunna fällas av Redis.
 *
 * `request.ip` litar på ingress-nginx:s `X-Forwarded-For`, redan
 * begränsat till Cloudflares IP-intervall i Terraform
 * (`proxy-real-ip-cidr`, docs/plan.md "Botskydd") — den verifieringen
 * har redan skett ETT STEG UPPSTRÖMS innan requesten når podden.
 *
 * Failar ÖPPET om Redis inte svarar: Redis "avgör aldrig om en stol får
 * reserveras" och "används till revokering och aktivitetsspårning, inte
 * som enda sanning" (docs/plan.md "Väntrum") — en Redis-hicka ska sakta
 * ner botskyddet, inte lägga ner hela försäljningen med 500:or.
 *
 * `allowlistedIps` (Fas 6, docs/plan.md "Lasttest": "Lastgeneratorernas
 * CF-verifierade adresser allowlistas i rate limitern under testet, med
 * dokumenterad motivering") — annars mäter lasttestet vårt eget
 * botskydd i stället för systemet. Tom som default; sätts bara
 * TILLFÄLLIGT via `RATE_LIMIT_ALLOWLISTED_IPS` för den faktiska
 * körningen (docs/runbook.md), aldrig permanent. Samma princip som
 * Stripe-undantaget ovan: `request.ip` är redan verifierat mot
 * Cloudflares intervall uppströms, aldrig en header en klient själv
 * kan sätta.
 */
import { checkRateLimit, type RedisClient } from '@tickets/redis';
import type { Logger } from '@tickets/observability';
import { TooManyRequestsError } from '@tickets/domain';
import type { FastifyInstance } from 'fastify';

const STRIPE_WEBHOOK_PATH_PREFIX = '/webhooks/stripe';
const EXEMPT_PATH_PREFIXES = ['/health/', '/metrics'];

export function registerRateLimitHook(
  app: FastifyInstance,
  redis: RedisClient,
  limitPerSecond: number,
  logger: Logger,
  allowlistedIps: ReadonlySet<string> = new Set(),
): void {
  app.addHook('onRequest', async (request) => {
    if (
      request.url.startsWith(STRIPE_WEBHOOK_PATH_PREFIX) ||
      EXEMPT_PATH_PREFIXES.some((prefix) => request.url.startsWith(prefix)) ||
      allowlistedIps.has(request.ip)
    ) {
      return;
    }
    let result: { allowed: boolean };
    try {
      result = await checkRateLimit(redis, request.ip, limitPerSecond);
    } catch (error) {
      logger.warn({ error, ip: request.ip }, 'rate limiter unreachable, failing open');
      return;
    }
    if (!result.allowed) {
      throw new TooManyRequestsError('rate limit exceeded', { ip: request.ip });
    }
  });
}
