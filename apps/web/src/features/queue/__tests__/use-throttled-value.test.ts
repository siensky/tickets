import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThrottledValue } from '../use-throttled-value.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useThrottledValue', () => {
  it('släpper igenom ett nytt värde först när intervallet gått', async () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 10_000), {
      initialProps: { value: 1 },
    });
    rerender({ value: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(result.current).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(result.current).toBe(2);
  });
});
