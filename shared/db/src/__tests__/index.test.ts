import { describe, expect, it } from 'vitest';
import { DB_PACKAGE_NAME } from '../index.js';

describe('@tickets/db placeholder', () => {
  it('exports its package marker', () => {
    expect(DB_PACKAGE_NAME).toBe('@tickets/db');
  });
});
