import { describe, expect, it } from 'vitest';
import {
  isDeadlockDetected,
  isLockNotAvailable,
  isUniqueViolation,
  isConnectionTimeout,
} from '../pg-errors.js';

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

describe('isConnectionTimeout', () => {
  it('matches pg-pool timing out while every connection is busy', () => {
    expect(isConnectionTimeout(new Error('timeout exceeded when trying to connect'))).toBe(
      true,
    );
  });

  it('matches a new connection to Postgres timing out', () => {
    expect(
      isConnectionTimeout(new Error('Connection terminated due to connection timeout')),
    ).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(
      isConnectionTimeout(new Error('canceling statement due to statement timeout')),
    ).toBe(false);
    expect(isConnectionTimeout({ message: 'timeout exceeded when trying to connect' })).toBe(
      false,
    );
    expect(isConnectionTimeout(undefined)).toBe(false);
  });
});
