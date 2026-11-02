import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ joinQueue: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api-client.js')>()),
  joinQueue: api.joinQueue,
}));
vi.mock('../analytics.js', () => analytics);

const { ApiError } = await import('../api-client.js');
const { joinQueueWithChallenge, parseRequirement, registerTurnstileListener, solvePow } =
  await import('../challenge.js');

function challengeError(challenge: Record<string, unknown>): InstanceType<typeof ApiError> {
  return new ApiError('challenge', 428, 'CHALLENGE_REQUIRED', { challenge });
}

async function sha256Bits(input: string): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  let bits = 0;
  for (const byte of digest) {
    if (byte !== 0) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

beforeEach(() => {
  api.joinQueue.mockReset();
  analytics.track.mockReset();
  registerTurnstileListener(undefined);
});

describe('parseRequirement', () => {
  it('läser en PoW- och en Turnstile-utmaning, och ignorerar andra fel', () => {
    expect(parseRequirement(challengeError({ type: 'pow', challenge: 'c', bits: 8 }))).toEqual(
      {
        type: 'pow',
        challenge: 'c',
        bits: 8,
      },
    );
    expect(parseRequirement(challengeError({ type: 'turnstile' }))).toEqual({
      type: 'turnstile',
    });
    expect(parseRequirement(new ApiError('x', 429, 'TOO_MANY_REQUESTS'))).toBeUndefined();
    expect(parseRequirement(challengeError({ type: 'pow' }))).toBeUndefined();
    expect(parseRequirement(new Error('nätverk'))).toBeUndefined();
  });
});

describe('solvePow', () => {
  it('hittar ett tal med tillräckligt många inledande nollbitar', async () => {
    const solution = await solvePow('utmaning', 8);

    expect(await sha256Bits(`utmaning:${solution}`)).toBeGreaterThanOrEqual(8);
  });
});

describe('joinQueueWithChallenge', () => {
  it('löser en PoW-utmaning osynligt och försöker igen med beviset som headers', async () => {
    api.joinQueue
      .mockRejectedValueOnce(challengeError({ type: 'pow', challenge: 'abc', bits: 8 }))
      .mockResolvedValueOnce({ token: 't' });

    await expect(joinQueueWithChallenge('e1')).resolves.toEqual({ token: 't' });

    const headers = api.joinQueue.mock.calls[1]?.[1] as Record<string, string>;
    expect(headers['x-pow-challenge']).toBe('abc');
    expect(await sha256Bits(`abc:${headers['x-pow-solution']}`)).toBeGreaterThanOrEqual(8);
    expect(analytics.track).toHaveBeenCalledWith('challenge_shown', {
      event_id: 'e1',
      challenge_type: 'pow',
    });
    expect(analytics.track).toHaveBeenCalledWith('challenge_passed', {
      event_id: 'e1',
      challenge_type: 'pow',
    });
  });

  it('hämtar ett Turnstile-token via ChallengeGate vid nivå 2', async () => {
    registerTurnstileListener((resolve) => resolve('turnstile-token'));
    api.joinQueue
      .mockRejectedValueOnce(challengeError({ type: 'turnstile' }))
      .mockResolvedValueOnce({ token: 't' });

    await joinQueueWithChallenge('e1');

    expect(api.joinQueue.mock.calls[1]?.[1]).toEqual({
      'x-turnstile-token': 'turnstile-token',
    });
  });

  it('ger upp efter tre försök och kastar det sista 428', async () => {
    api.joinQueue.mockRejectedValue(
      challengeError({ type: 'pow', challenge: 'abc', bits: 1 }),
    );

    await expect(joinQueueWithChallenge('e1')).rejects.toMatchObject({ status: 428 });
    expect(api.joinQueue).toHaveBeenCalledTimes(3);
  });

  it('kastar andra fel direkt och skickar inga händelser utan utmaning', async () => {
    api.joinQueue.mockRejectedValueOnce(new ApiError('slut', 429, 'TOO_MANY_REQUESTS'));
    await expect(joinQueueWithChallenge('e1')).rejects.toMatchObject({ status: 429 });

    api.joinQueue.mockResolvedValueOnce({ token: 't' });
    await joinQueueWithChallenge('e1');
    expect(analytics.track).not.toHaveBeenCalled();
  });
});
