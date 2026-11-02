import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPowKey,
  issuePowChallenge,
  leadingZeroBits,
  powChallengeHash,
  verifyPow,
} from '../../src/services/pow.js';

const KEY = createPowKey(new TextEncoder().encode('unit-test-secret-at-least-32-bytes!!!!'));
const EVENT = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;

function solve(challenge: string, bits: number): string {
  for (let candidate = 0; ; candidate += 1) {
    const digest = createHash('sha256').update(`${challenge}:${candidate}`).digest();
    if (leadingZeroBits(digest) >= bits) {
      return String(candidate);
    }
  }
}

describe('leadingZeroBits', () => {
  it('counts zero bits across bytes', () => {
    expect(leadingZeroBits(Buffer.from([0x00, 0x0f]))).toBe(12);
    expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0x00, 0x00]))).toBe(16);
  });
});

describe('verifyPow', () => {
  const issued = issuePowChallenge(KEY, '1.2.3.4', EVENT, 8, NOW, 120);
  const solution = solve(issued.challenge, 8);

  it('accepts a correct solution', () => {
    expect(verifyPow(KEY, issued.challenge, solution, '1.2.3.4', EVENT, NOW)).toBe('ok');
  });

  it('rejects a solution that does not have enough zero bits', () => {
    let wrong = 0;
    while (
      leadingZeroBits(createHash('sha256').update(`${issued.challenge}:${wrong}`).digest()) >=
      8
    ) {
      wrong += 1;
    }

    expect(verifyPow(KEY, issued.challenge, String(wrong), '1.2.3.4', EVENT, NOW)).toBe(
      'invalid',
    );
  });

  it('only accepts the canonical form that was issued (no reformatted variants)', () => {
    const [expires, bits, nonce, mac] = issued.challenge.split('.');
    const variants = [
      `0${expires}.${bits}.${nonce}.${mac}`,
      `${expires}.${bits}.${nonce}.${(mac ?? '').toUpperCase()}`,
      `${expires}.0${bits}.${nonce}.${mac}`,
      `${issued.challenge}.extra`,
    ];
    for (const variant of variants) {
      expect(verifyPow(KEY, variant, solution, '1.2.3.4', EVENT, NOW)).toBe('invalid');
    }
  });

  it('is bound to the ip and the event', () => {
    expect(verifyPow(KEY, issued.challenge, solution, '9.9.9.9', EVENT, NOW)).toBe('invalid');
    expect(
      verifyPow(
        KEY,
        issued.challenge,
        solution,
        '1.2.3.4',
        '22222222-2222-4222-8222-222222222222',
        NOW,
      ),
    ).toBe('invalid');
  });

  it('reports an expired challenge, but only for a genuine signature', () => {
    expect(verifyPow(KEY, issued.challenge, solution, '1.2.3.4', EVENT, NOW + 121_000)).toBe(
      'expired',
    );
  });

  it('rejects tampering with the difficulty (cannot lower bits)', () => {
    const [expires, , nonce, mac] = issued.challenge.split('.');
    const forged = `${expires}.1.${nonce}.${mac}`;
    expect(verifyPow(KEY, forged, solve(forged, 1), '1.2.3.4', EVENT, NOW)).toBe('invalid');
  });

  it('rejects malformed input and oversized solutions', () => {
    expect(verifyPow(KEY, 'garbage', '1', '1.2.3.4', EVENT, NOW)).toBe('invalid');
    expect(verifyPow(KEY, issued.challenge, '', '1.2.3.4', EVENT, NOW)).toBe('invalid');
    expect(verifyPow(KEY, issued.challenge, '9'.repeat(100), '1.2.3.4', EVENT, NOW)).toBe(
      'invalid',
    );
  });

  it('gives every challenge a unique hash', () => {
    const other = issuePowChallenge(KEY, '1.2.3.4', EVENT, 8, NOW, 120);
    expect(powChallengeHash(other.challenge)).not.toBe(powChallengeHash(issued.challenge));
  });
});
