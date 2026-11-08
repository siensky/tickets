/**
 * Config-cache med kort TTL (docs/plan.md "Redis — användningsområden":
 * "Värdena från config-tabellen, med Pub/Sub-invalidering ELLER 5 s
 * TTL" — den här filen väljer TTL-varianten: enklare, och en stale läsning
 * i upp till 5 s är ofarlig för väntrummets insläppstakt/sessionstid).
 *
 * Läses mycket oftare än reservationskonfigen (varje köstatus-polling,
 * tusentals/s under en storm) — det är det som gör en cache värd att ha
 * här men inte för `getReservationConfig` (läst en gång per
 * reservationsförsök).
 */
import type { Redis } from 'ioredis';
import { configCacheKey } from './keys.js';

export async function getCachedConfigValue(
  redis: Redis,
  key: string,
  ttlSeconds: number,
  loadFromSource: () => Promise<string>,
): Promise<string> {
  const cached = await redis.get(configCacheKey(key));
  if (cached !== null) {
    return cached;
  }
  const value = await loadFromSource();
  await redis.set(configCacheKey(key), value, 'EX', ttlSeconds);
  return value;
}
