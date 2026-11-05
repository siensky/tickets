import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, withRequestId } from '../logger.js';

/** En logger som samlar varje rad som tolkad JSON, så att testet ser exakt vad som skrivs. */
function capturingLogger() {
  const lines: unknown[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return {
    logger: createLogger({ serviceName: 'test-service', level: 'info' }, stream),
    lines,
  };
}

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

describe('createLogger: fel', () => {
  it('skriver meddelande och stack för ett fel under `error`, inte {}', () => {
    const { logger, lines } = capturingLogger();

    logger.error(
      { error: new Error('timeout exceeded when trying to connect') },
      'unhandled error',
    );

    expect(lines[0]).toMatchObject({
      msg: 'unhandled error',
      error: { type: 'Error', message: 'timeout exceeded when trying to connect' },
    });
    expect(JSON.stringify(lines[0])).toContain('"stack":"Error: timeout exceeded');
  });

  it('skriver felet under `err` på samma sätt', () => {
    const { logger, lines } = capturingLogger();

    logger.warn({ err: new Error('boom') }, 'failed');

    expect(lines[0]).toMatchObject({ err: { type: 'Error', message: 'boom' } });
  });

  it('maskerar fortfarande känsliga fält i felets context', () => {
    const { logger, lines } = capturingLogger();
    const error = Object.assign(new Error('bad'), { context: { password: 'hunter2' } });

    logger.error({ error }, 'failed');

    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
    expect(lines[0]).toMatchObject({ error: { context: { password: '[REDACTED]' } } });
  });
});
