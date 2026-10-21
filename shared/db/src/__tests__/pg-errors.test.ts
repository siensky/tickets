import { describe, expect, it } from 'vitest';
import { isDeadlockDetected, isLockNotAvailable, isUniqueViolation } from '../pg-errors.js';

describe('isUniqueViolation', () => {
  it('matches 23505 with the given constraint name', () => {
    expect(
      isUniqueViolation({ code: '23505', constraint: 'my_constraint' }, 'my_constraint'),
    ).toBe(true);
  });

  it('rejects a different constraint name', () => {
    expect(isUniqueViolation({ code: '23505', constraint: 'other' }, 'my_constraint')).toBe(
      false,
    );
  });

  it('rejects a non-error-shaped value', () => {
    expect(isUniqueViolation('boom', 'my_constraint')).toBe(false);
    expect(isUniqueViolation(null, 'my_constraint')).toBe(false);
  });
});

describe('isLockNotAvailable', () => {
  it('matches 55P03', () => {
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
  });

  it('rejects other codes', () => {
    expect(isLockNotAvailable({ code: '40P01' })).toBe(false);
  });
});

describe('isDeadlockDetected', () => {
  it('matches 40P01', () => {
    expect(isDeadlockDetected({ code: '40P01' })).toBe(true);
  });

  it('rejects other codes', () => {
    expect(isDeadlockDetected({ code: '55P03' })).toBe(false);
  });
});
