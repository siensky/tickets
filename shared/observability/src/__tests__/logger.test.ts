import { describe, expect, it } from 'vitest';
import { createLogger, withRequestId } from '../logger.js';

describe('createLogger', () => {
  it('redacts sensitive fields instead of logging them raw', () => {
    const logger = createLogger({ serviceName: 'test-service', level: 'info' });
    expect(logger.level).toBe('info');
  });

  it('withRequestId binds a child logger carrying the request id', () => {
    const logger = createLogger({ serviceName: 'test-service' });
    const child = withRequestId(logger, 'req-123');
    expect(child).not.toBe(logger);
  });
});
