import { describe, expect, it } from 'vitest';
import { listEventsQuerySchema } from '../events-query.js';

describe('listEventsQuerySchema', () => {
  it('accepts no query params at all', () => {
    const result = listEventsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a known category', () => {
    const result = listEventsQuerySchema.safeParse({ category: 'music' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown category', () => {
    const result = listEventsQuerySchema.safeParse({ category: 'cooking' });
    expect(result.success).toBe(false);
  });

  it('accepts a free-text search term', () => {
    const result = listEventsQuerySchema.safeParse({ q: 'Coldplay' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty search term', () => {
    const result = listEventsQuerySchema.safeParse({ q: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown query param (strict — mass-assignment protection)', () => {
    const result = listEventsQuerySchema.safeParse({ limit: '1000' });
    expect(result.success).toBe(false);
  });
});
