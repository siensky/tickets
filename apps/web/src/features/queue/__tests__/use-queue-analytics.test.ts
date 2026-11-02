import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueStatusResult } from '../../../lib/api-client.js';
import { useQueueAnalytics } from '../use-queue-analytics.js';

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics.js', () => ({ track }));
vi.mock('../../analytics/use-event-context.js', () => ({
  useEventContext: () => ({ event_id: 'e1', category: 'music' }),
}));

const WAITING: QueueStatusResult = { status: 'waiting', position: 5, queueDepth: 20 };
const ADMITTED: QueueStatusResult = { status: 'admitted' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  track.mockClear();
});

function renderQueue(initial: { isJoining: boolean; status: QueueStatusResult | undefined }) {
  return renderHook((props) => useQueueAnalytics('e1', props.isJoining, props.status), {
    initialProps: initial,
  });
}

describe('useQueueAnalytics', () => {
  it('skickar queue_joined och sedan queue_admitted med väntetiden', () => {
    const { rerender } = renderQueue({ isJoining: true, status: undefined });
    expect(track).not.toHaveBeenCalled();

    rerender({ isJoining: false, status: WAITING });
    expect(track).toHaveBeenCalledWith('queue_joined', { event_id: 'e1', category: 'music' });
    vi.advanceTimersByTime(42_000);
    rerender({ isJoining: false, status: ADMITTED });

    expect(track).toHaveBeenCalledWith('queue_admitted', {
      event_id: 'e1',
      category: 'music',
      wait_seconds: 42,
    });
  });

  it('skickar queue_left när skärmen lämnas före insläpp', () => {
    const { rerender, unmount } = renderQueue({ isJoining: true, status: undefined });
    rerender({ isJoining: false, status: WAITING });
    vi.advanceTimersByTime(7_000);
    unmount();

    expect(track).toHaveBeenCalledWith('queue_left', {
      event_id: 'e1',
      category: 'music',
      wait_seconds: 7,
    });
  });

  it('skickar inte queue_left efter insläpp', () => {
    const { rerender, unmount } = renderQueue({ isJoining: true, status: undefined });
    rerender({ isJoining: false, status: ADMITTED });
    unmount();

    expect(track).not.toHaveBeenCalledWith('queue_left', expect.anything());
  });

  it('skickar varken queue_joined eller queue_left när anslutningen till kön misslyckas', () => {
    const { rerender, unmount } = renderQueue({ isJoining: true, status: undefined });
    rerender({ isJoining: false, status: undefined });
    unmount();

    expect(track).not.toHaveBeenCalled();
  });

  it('skickar inga händelser för en återupptagen kö (ingen join på den här skärmen)', () => {
    const { unmount } = renderQueue({ isJoining: false, status: WAITING });
    unmount();
    expect(track).not.toHaveBeenCalled();
  });
});
