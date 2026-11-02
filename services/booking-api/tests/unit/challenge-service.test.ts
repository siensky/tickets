/**
 * Nivåberäkningen i botskyddet (docs/plan.md 8.5) mot en minnesbaserad Redis: vilka signaler som ger vilken nivå,
 * att IP-volym räknas som EN signal, kill switch, bypass, fail-open och att Turnstile aldrig anropas på nivå 1.
 */
import { createHash } from 'node:crypto';
import type { ShardPools } from '@tickets/db';
import { ChallengeRequiredError } from '@tickets/domain';
import { createLogger } from '@tickets/observability';
import { configCacheKey, type RedisClient } from '@tickets/redis';
import { describe, expect, it, vi } from 'vitest';
import {
  enforceJoinChallenge,
  type ChallengeDeps,
  type JoinRequestInfo,
} from '../../src/services/challenge-service.js';
import { createPowKey, leadingZeroBits } from '../../src/services/pow.js';
import type { ChallengeConfig } from '../../src/types/challenge.js';

const BROWSER =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const EVENT = '11111111-1111-4111-8111-111111111111';
const DEFAULT_CONFIG: ChallengeConfig = {
  enabled: true,
  ipAttemptsPerMinute: 3,
  ipJoinsPerWindow: 3,
  globalQueueDepth: 0,
  powBits: 8,
};

function fakeRedis(config: ChallengeConfig): RedisClient {
  const store = new Map<string, string>([
    [configCacheKey('challenge_bundle'), JSON.stringify(config)],
  ]);
  const incr = (key: string): number => {
    const next = Number(store.get(key) ?? '0') + 1;
    store.set(key, String(next));
    return next;
  };
  return {
    eval: vi.fn((_script: string, _keys: number, key: string) => Promise.resolve(incr(key))),
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    decr: vi.fn((key: string) => {
      const next = Number(store.get(key) ?? '0') - 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    del: vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    zcard: vi.fn(() => Promise.resolve(0)),
  } as unknown as RedisClient;
}

function deps(overrides: Partial<ChallengeDeps> = {}, config = DEFAULT_CONFIG): ChallengeDeps {
  return {
    shardPools: {} as unknown as ShardPools,
    redis: fakeRedis(config),
    logger: createLogger({ serviceName: 'test' }),
    powKey: createPowKey(new TextEncoder().encode('unit-test-secret-at-least-32-bytes!!!!')),
    turnstile: { secret: 's', expectedHostname: undefined },
    bypassToken: undefined,
    ...overrides,
  };
}

function info(overrides: Partial<JoinRequestInfo> = {}): JoinRequestInfo {
  return {
    eventId: EVENT,
    ip: '10.0.0.1',
    userAgent: BROWSER,
    bypass: undefined,
    proof: { powChallenge: undefined, powSolution: undefined, turnstileToken: undefined },
    ...overrides,
  };
}

async function challengeType(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      const challenge: unknown = error.context?.['challenge'];
      return typeof challenge === 'object' && challenge !== null
        ? String(Reflect.get(challenge, 'type'))
        : undefined;
    }
    throw error;
  }
}

function solve(challenge: string, bits: number): string {
  for (let candidate = 0; ; candidate += 1) {
    const digest = createHash('sha256').update(`${challenge}:${candidate}`).digest();
    if (leadingZeroBits(digest) >= bits) return String(candidate);
  }
}

describe('nivåberäkning', () => {
  it('nivå 0: en vanlig webbläsare under tröskeln utmanas inte', async () => {
    expect(await challengeType(enforceJoinChallenge(deps(), info()))).toBeUndefined();
  });

  it('nivå 1: en enda signal (automat-User-Agent) ger proof of work', async () => {
    expect(
      await challengeType(enforceJoinChallenge(deps(), info({ userAgent: 'curl/8' }))),
    ).toBe('pow');
    expect(
      await challengeType(enforceJoinChallenge(deps(), info({ userAgent: undefined }))),
    ).toBe('pow');
  });

  it('en mobiltillverkare med "bot" i namnet är ingen automat', async () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 12; CUBOT KINGKONG) Chrome/126.0 Mobile Safari/537.36';
    expect(
      await challengeType(enforceJoinChallenge(deps(), info({ userAgent: ua }))),
    ).toBeUndefined();
  });

  it('IP-volymen (försök och join) är EN signal: ett delat nät ensamt ger bara nivå 1', async () => {
    const shared = deps();
    const results: (string | undefined)[] = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(await challengeType(enforceJoinChallenge(shared, info())));
    }

    expect(results.at(-1)).toBe('pow');
    expect(results).not.toContain('turnstile');
  });

  it('nivå 2: två olika signaler ger Turnstile, men bara om en secret finns', async () => {
    const strict = deps({}, { ...DEFAULT_CONFIG, ipAttemptsPerMinute: 0 });
    expect(
      await challengeType(enforceJoinChallenge(strict, info({ userAgent: 'curl/8' }))),
    ).toBe('turnstile');

    const noSecret = deps(
      { turnstile: undefined },
      { ...DEFAULT_CONFIG, ipAttemptsPerMinute: 0 },
    );
    expect(
      await challengeType(enforceJoinChallenge(noSecret, info({ userAgent: 'curl/8' }))),
    ).toBe('pow');
  });

  it('en lösning släpper igenom en gång, och Turnstile anropas aldrig på nivå 1', async () => {
    const fetchFn = vi.fn();
    const d = deps({ fetchFn });
    let challenge = '';
    try {
      await enforceJoinChallenge(d, info({ userAgent: 'curl/8' }));
    } catch (error) {
      const c: unknown =
        error instanceof ChallengeRequiredError ? error.context?.['challenge'] : null;
      challenge = String(Reflect.get(c as object, 'challenge'));
    }
    const proof = {
      powChallenge: challenge,
      powSolution: solve(challenge, 8),
      turnstileToken: 'påhittad',
    };

    await enforceJoinChallenge(d, info({ userAgent: 'curl/8', proof }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      await challengeType(enforceJoinChallenge(d, info({ userAgent: 'curl/8', proof }))),
    ).toBe('pow');
  });

  it('kill switchen och bypass-headern släpper igenom', async () => {
    const off = deps({}, { ...DEFAULT_CONFIG, enabled: false });
    expect(
      await challengeType(enforceJoinChallenge(off, info({ userAgent: 'curl/8' }))),
    ).toBeUndefined();

    const withBypass = deps({ bypassToken: 'hemlig' });
    expect(
      await challengeType(
        enforceJoinChallenge(withBypass, info({ userAgent: 'curl/8', bypass: 'hemlig' })),
      ),
    ).toBeUndefined();
    expect(
      await challengeType(
        enforceJoinChallenge(withBypass, info({ userAgent: 'curl/8', bypass: 'fel' })),
      ),
    ).toBe('pow');
  });

  it('släpper igenom (fail-open) när Redis inte svarar', async () => {
    const broken = deps();
    vi.spyOn(broken.redis, 'get').mockRejectedValue(new Error('redis down'));

    expect(
      await challengeType(enforceJoinChallenge(broken, info({ userAgent: 'curl/8' }))),
    ).toBeUndefined();
  });
});
