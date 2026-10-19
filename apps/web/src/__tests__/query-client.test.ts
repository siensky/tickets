import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryClient } from '../lib/query-client.js';

describe('queryClient', () => {
  it('is a configured QueryClient instance', () => {
    expect(queryClient).toBeInstanceOf(QueryClient);
  });
});
