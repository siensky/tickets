import { describe, expect, it } from 'vitest';
import { RABBIT_PACKAGE_NAME } from '../index.js';

describe('@tickets/rabbit placeholder', () => {
  it('exports its package marker', () => {
    expect(RABBIT_PACKAGE_NAME).toBe('@tickets/rabbit');
  });
});
