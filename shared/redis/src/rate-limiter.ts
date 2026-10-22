/**
 * Rate limiting per IP (docs/plan.md "Botskydd": "Rate limiting per IP
 * (Redis, ~1 ms) — alltid på"). Fast fönster, INCR + EXPIRE — exakt den
 * primitiv planen anger, inte en sliding-window-algoritm.
 *
 * EXPIRE sätts bara på den FÖRSTA ökningen i ett fönster (`current ===
 * 1`) — att sätta den på varje anrop hade låtit en jämn ström av
 * requests knuffa fönstret framåt i evighet, så en klient hade aldrig
 * kunnat komma tillbaka in igen när den väl börjat.
 */
import type { Redis } from 'ioredis';
import { rateLimitKey } from './keys.js';

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly count: number;
}

export async function checkRateLimit(
  redis: Redis,
  ip: string,
  limitPerWindow: number,
  windowSeconds = 1,
): Promise<RateLimitResult> {
  const raw: unknown = await redis.eval(RATE_LIMIT_SCRIPT, 1, rateLimitKey(ip), windowSeconds);
  if (typeof raw !== 'number') {
    throw new TypeError(`rate limit script returned a non-number: ${typeof raw}`);
  }
  return { allowed: raw <= limitPerWindow, count: raw };
}
