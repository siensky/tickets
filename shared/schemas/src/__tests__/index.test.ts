import { describe, expect, it } from 'vitest';
import { SCHEMAS_PACKAGE_NAME } from '../index.js';

describe('@tickets/schemas placeholder', () => {
  it('exports its package marker', () => {
    expect(SCHEMAS_PACKAGE_NAME).toBe('@tickets/schemas');
  });
});
