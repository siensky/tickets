import { describe, expect, it } from 'vitest';
import { AUTH_PACKAGE_NAME } from '../index.js';

describe('@tickets/auth placeholder', () => {
  it('exports its package marker', () => {
    expect(AUTH_PACKAGE_NAME).toBe('@tickets/auth');
  });
});
