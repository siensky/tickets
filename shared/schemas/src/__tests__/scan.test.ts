/** Enhetstest för body-schemat till POST /scans (docs/plan.md 7.13 E7). */
import { describe, expect, it } from 'vitest';
import { scanBodySchema } from '../scan.js';

const VALID = {
  eventId: '123e4567-e89b-42d3-a456-426614174000',
  qrToken: 'ab'.repeat(32),
  gate: 'Grind A',
};

describe('scanBodySchema', () => {
  it('accepts a valid body and trims the gate', () => {
    const result = scanBodySchema.safeParse({ ...VALID, gate: '  Grind B ' });
    expect(result.success && result.data.gate).toBe('Grind B');
  });

  it.each([
    ['a non-uuid eventId', { eventId: 'x' }],
    ['a qrToken that is not 64 hex characters', { qrToken: 'abc' }],
    ['an empty gate', { gate: ' ' }],
    ['a gate longer than 32 characters', { gate: 'g'.repeat(33) }],
    ['an unknown field', { extra: 1 }],
  ])('rejects %s', (_label, override) => {
    expect(scanBodySchema.safeParse({ ...VALID, ...override }).success).toBe(false);
  });
});
