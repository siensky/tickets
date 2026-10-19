import { describe, expect, it } from 'vitest';
import { REDIS_PACKAGE_NAME } from '../index.js';

describe('@tickets/redis placeholder', () => {
  it('exports its package marker', () => {
    expect(REDIS_PACKAGE_NAME).toBe('@tickets/redis');
  });
});
