/** Enhetstest för scan-debounce (scannern, docs/plan.md 7.8). */
import { describe, expect, it } from 'vitest';
import { createScanDebouncer } from '../scan-debounce.js';

describe('createScanDebouncer', () => {
  it('släpper igenom första skanningen men inte samma kod igen inom fönstret', () => {
    const debouncer = createScanDebouncer(3000);
    expect(debouncer.accept('abc', 0)).toBe(true);
    expect(debouncer.accept('abc', 2999)).toBe(false);
  });

  it('släpper igenom samma kod igen när fönstret gått', () => {
    const debouncer = createScanDebouncer(3000);
    debouncer.accept('abc', 0);
    expect(debouncer.accept('abc', 3000)).toBe(true);
  });

  it('släpper igenom en annan kod direkt', () => {
    const debouncer = createScanDebouncer(3000);
    debouncer.accept('abc', 0);
    expect(debouncer.accept('def', 10)).toBe(true);
  });

  it('reset() låter samma kod skannas om direkt', () => {
    const debouncer = createScanDebouncer(3000);
    debouncer.accept('abc', 0);
    debouncer.reset();
    expect(debouncer.accept('abc', 10)).toBe(true);
  });
});
