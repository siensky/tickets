/**
 * Dedupe för notifikationer (docs/plan.md "Idempotens": "Notifikationer:
 * Redis-set med TTL"). Lägre konsekvens än `processed_messages`
 * (pengar/biljetter, docs/rules.md §... se shared/domain) — en dubbel
 * notis är ofarlig, så en TTL-skyddad Redis-nyckel räcker i stället för
 * en databastabell.
 *
 * SETNX + EXPIRE i ett skript: utan atomiciteten kunde två konsumenter
 * som kör samma meddelande-id samtidigt båda läsa "inte bearbetad" innan
 * någon av dem hunnit sätta nyckeln.
 */
import type { Redis } from 'ioredis';
import { notificationDedupeKey } from './keys.js';

const CLAIM_SCRIPT = `
if redis.call('SETNX', KEYS[1], '1') == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

/** Returnerar `true` om det här är FÖRSTA gången meddelande-id:t ses (dvs. det ska bearbetas). */
export async function claimNotification(
  redis: Redis,
  messageId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const raw: unknown = await redis.eval(
    CLAIM_SCRIPT,
    1,
    notificationDedupeKey(messageId),
    ttlSeconds,
  );
  if (typeof raw !== 'number') {
    throw new TypeError(`notification dedupe script returned a non-number: ${typeof raw}`);
  }
  return raw === 1;
}

/**
 * Frigör claimen om bearbetningen av meddelandet misslyckades EFTER att
 * den togs (t.ex. ett transient databas- eller mejlfel) — annars dedupas
 * en redelivery mot den redan satta nyckeln, och notifikationen skickas
 * aldrig, trots att den faktiskt aldrig gick iväg första gången.
 */
export async function releaseNotificationClaim(
  redis: Redis,
  messageId: string,
): Promise<void> {
  await redis.del(notificationDedupeKey(messageId));
}
