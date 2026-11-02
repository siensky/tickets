/**
 * Proof of work för botskyddets nivå 1 (docs/plan.md 8.5). Utmaningen är stateless: en HMAC-signerad sträng
 * över `ip|eventId|utgångstid|svårighet|nonce`, så servern lagrar ingenting förrän en lösning används (då
 * markeras den som använd i Redis, se challenge-service.ts). Lösningen är ett tal `s` så att
 * SHA-256(`<utmaning>:<s>`) börjar med minst `bits` nollbitar. Webbläsarens lösare (apps/web/src/lib/challenge.ts)
 * måste hasha exakt samma sträng.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const POW_DOMAIN = 'tickets:challenge:pow:v1';
const MAX_BITS = 24;
const MAX_SOLUTION_LENGTH = 32;

export interface PowChallenge {
  readonly challenge: string;
  readonly bits: number;
  readonly expiresAt: number;
}

export type PowVerdict = 'ok' | 'invalid' | 'expired';

/** Egen nyckel härledd ur kötokenhemligheten, så att en signatur aldrig kan förväxlas med ett kötoken. */
export function createPowKey(queueTokenSecret: Uint8Array): Buffer {
  return createHmac('sha256', queueTokenSecret).update(POW_DOMAIN).digest();
}

function sign(
  key: Buffer,
  ip: string,
  eventId: string,
  expiresAt: number,
  bits: number,
  nonce: string,
): string {
  return createHmac('sha256', key)
    .update(`${ip}|${eventId}|${expiresAt}|${bits}|${nonce}`)
    .digest('hex');
}

export function issuePowChallenge(
  key: Buffer,
  ip: string,
  eventId: string,
  bits: number,
  nowMs: number,
  ttlSeconds: number,
): PowChallenge {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const nonce = randomBytes(12).toString('hex');
  const mac = sign(key, ip, eventId, expiresAt, bits, nonce);
  return { challenge: `${expiresAt}.${bits}.${nonce}.${mac}`, bits, expiresAt };
}

export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function parseChallenge(
  challenge: string,
): { expiresAt: number; bits: number; nonce: string; mac: string } | undefined {
  const [expiresRaw, bitsRaw, nonce, mac, extra] = challenge.split('.');
  if (
    expiresRaw === undefined ||
    bitsRaw === undefined ||
    nonce === undefined ||
    mac === undefined ||
    extra !== undefined
  ) {
    return undefined;
  }
  const expiresAt = Number(expiresRaw);
  const bits = Number(bitsRaw);
  // Kanonisk form: strängen måste vara exakt den som utfärdades, så att inga omformade varianter (inledande
  // nollor, versaler, udda hex) kan ge nya "unika" utmaningar av en enda utfärdad.
  if (
    String(expiresAt) !== expiresRaw ||
    String(bits) !== bitsRaw ||
    !Number.isInteger(expiresAt) ||
    bits < 1 ||
    bits > MAX_BITS ||
    !/^[0-9a-f]{24}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(mac)
  ) {
    return undefined;
  }
  return { expiresAt, bits, nonce, mac };
}

function macMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Kontrollerar signatur (bunden till ip och event), utgångstid och att lösningen har tillräckligt många nollbitar. */
export function verifyPow(
  key: Buffer,
  challenge: string,
  solution: string,
  ip: string,
  eventId: string,
  nowMs: number,
): PowVerdict {
  const parsed = parseChallenge(challenge);
  if (parsed === undefined || solution.length === 0 || solution.length > MAX_SOLUTION_LENGTH) {
    return 'invalid';
  }
  const expected = sign(key, ip, eventId, parsed.expiresAt, parsed.bits, parsed.nonce);
  if (!macMatches(expected, parsed.mac)) {
    return 'invalid';
  }
  if (parsed.expiresAt * 1000 < nowMs) {
    return 'expired';
  }
  const digest = createHash('sha256').update(`${challenge}:${solution}`).digest();
  return leadingZeroBits(digest) >= parsed.bits ? 'ok' : 'invalid';
}

/** Hash som identifierar en utmaning i Redis (engångsmarkeringen), så att nyckeln inte bär själva utmaningen. */
export function powChallengeHash(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex');
}
