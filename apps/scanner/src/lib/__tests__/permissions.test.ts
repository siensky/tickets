/** Enhetstest för permissions (scannern, docs/plan.md 7.8). */
import { describe, expect, it } from 'vitest';
import { readPermissions } from '../permissions.js';

function tokenWith(payload: unknown): string {
  const encoded = btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_');
  return `header.${encoded}.signature`;
}

describe('readPermissions', () => {
  it('läser permissions ur access-tokenets payload', () => {
    expect(readPermissions(tokenWith({ permissions: ['scan:tickets', 'x'] }))).toEqual([
      'scan:tickets',
      'x',
    ]);
  });

  it('ger tom lista när permissions saknas eller tokenet inte går att läsa', () => {
    expect(readPermissions(tokenWith({ sub: 'a' }))).toEqual([]);
    expect(readPermissions(tokenWith({ permissions: 'scan:tickets' }))).toEqual([]);
    expect(readPermissions('inte-ett-token')).toEqual([]);
    expect(readPermissions('a.@@@.c')).toEqual([]);
  });
});
