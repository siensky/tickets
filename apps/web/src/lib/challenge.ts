/**
 * Klientsidan av botskyddet (docs/plan.md 8.5). `queue/join` kan svara 428 med en utmaning: ett proof of work
 * löses osynligt här (SHA-256 med N inledande nollbitar över `<utmaning>:<tal>`, samma sträng som servern
 * hashar), och ett Turnstile-token hämtas via `ChallengeGate` (den enda delen som syns). Efter lösningen
 * görs ett nytt försök med beviset som headers; högst tre försök totalt.
 */
import { track } from './analytics.js';
import { ApiError, joinQueue, type JoinQueueResult } from './api-client.js';

const MAX_ATTEMPTS = 3;
const YIELD_EVERY = 2000;

export type ChallengeRequirement =
  | { readonly type: 'pow'; readonly challenge: string; readonly bits: number }
  | { readonly type: 'turnstile' };

function readField(data: unknown, field: string): unknown {
  return typeof data === 'object' && data !== null ? Reflect.get(data, field) : undefined;
}

export function parseRequirement(error: unknown): ChallengeRequirement | undefined {
  if (
    !(error instanceof ApiError) ||
    error.status !== 428 ||
    error.code !== 'CHALLENGE_REQUIRED'
  ) {
    return undefined;
  }
  const challenge = readField(error.context, 'challenge');
  const type = readField(challenge, 'type');
  if (type === 'turnstile') {
    return { type };
  }
  const value = readField(challenge, 'challenge');
  const bits = readField(challenge, 'bits');
  return type === 'pow' && typeof value === 'string' && typeof bits === 'number'
    ? { type, challenge: value, bits }
    : undefined;
}

function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte !== 0) {
      return bits + Math.clz32(byte) - 24;
    }
    bits += 8;
  }
  return bits;
}

/** Letar ett tal vars hash har `bits` nollbitar. Ger fliken luft var 2000:e försök så att sidan inte hänger. */
export async function solvePow(challenge: string, bits: number): Promise<string> {
  const encoder = new TextEncoder();
  for (let candidate = 0; ; candidate += 1) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`${challenge}:${candidate}`),
    );
    if (leadingZeroBits(new Uint8Array(digest)) >= bits) {
      return String(candidate);
    }
    if (candidate % YIELD_EVERY === YIELD_EVERY - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

type TurnstileListener = (
  resolve: (token: string) => void,
  reject: (error: Error) => void,
) => void;
let turnstileListener: TurnstileListener | undefined;

/** `ChallengeGate` registrerar sig här; utan en monterad gate går det inte att visa Turnstile. */
export function registerTurnstileListener(listener: TurnstileListener | undefined): void {
  turnstileListener = listener;
}

function requestTurnstileToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (turnstileListener === undefined) {
      reject(new Error('no ChallengeGate mounted'));
      return;
    }
    turnstileListener(resolve, reject);
  });
}

/** Löser kravet och returnerar beviset som request-headers (servern läser `x-pow-*` / `x-turnstile-token`). */
async function resolveRequirement(
  requirement: ChallengeRequirement,
): Promise<Record<string, string>> {
  if (requirement.type === 'turnstile') {
    return { 'x-turnstile-token': await requestTurnstileToken() };
  }
  return {
    'x-pow-challenge': requirement.challenge,
    'x-pow-solution': await solvePow(requirement.challenge, requirement.bits),
  };
}

/** `joinQueue` som hanterar 428: löser utmaningen och försöker igen. Andra fel kastas som de är. */
export async function joinQueueWithChallenge(eventId: string): Promise<JoinQueueResult> {
  let proof: Record<string, string> = {};
  let lastType: ChallengeRequirement['type'] | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await joinQueue(eventId, proof);
      if (lastType !== undefined) {
        track('challenge_passed', { event_id: eventId, challenge_type: lastType });
      }
      return result;
    } catch (error) {
      const requirement = parseRequirement(error);
      if (requirement === undefined || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      lastType = requirement.type;
      track('challenge_shown', { event_id: eventId, challenge_type: requirement.type });
      proof = await resolveRequirement(requirement);
    }
  }
}
