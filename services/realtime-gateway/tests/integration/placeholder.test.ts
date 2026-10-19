import { describe, expect, it } from 'vitest';
import { start } from '../../src/index.js';

describe('realtime-gateway entrypoint', () => {
  it('exports a start function', () => {
    expect(typeof start).toBe('function');
  });
});
