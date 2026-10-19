import { createLogger } from '@tickets/observability';
import { describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from '../../src/services/heartbeat.js';

describe('startHeartbeat', () => {
  it('returns a timer that can be cleared', () => {
    vi.useFakeTimers();
    const logger = createLogger({ serviceName: 'test' });
    const timer = startHeartbeat(logger, 1000);
    expect(timer).toBeDefined();
    clearInterval(timer);
    vi.useRealTimers();
  });
});
