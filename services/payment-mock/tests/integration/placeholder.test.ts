import { describe, expect, it } from 'vitest';
import { start } from '../../src/index.js';

describe('payment-mock entrypoint', () => {
  it('exports a start function', () => {
    expect(typeof start).toBe('function');
  });
});
