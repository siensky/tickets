import Fastify from 'fastify';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { createSlowRequestHook, QuietRequestLogController } from '../request-logging.js';

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  // Bara `warn` används av hooken.
  return { logger: { warn } as unknown as Logger, warn };
}

/** En riktig pino-logger som samlar varje rad, så att testet ser exakt vad Fastify skriver. */
function capturingLogger(): { logger: pino.Logger; messages: () => string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = pino({ level: 'info' }, stream);
  return {
    logger,
    messages: () => lines.map((line) => String((JSON.parse(line) as { msg?: unknown }).msg)),
  };
}

const request = {
  id: 'req-1',
  method: 'GET',
  routeOptions: { url: '/events/:eventId' },
};

describe('createSlowRequestHook', () => {
  it('loggar ett anrop som tog längre tid än tröskeln, med route-mönstret och inte den råa URL:en', async () => {
    const { logger, warn } = fakeLogger();
    await createSlowRequestHook(logger, 1000)(request, {
      statusCode: 200,
      elapsedTime: 1500.4,
    });

    expect(warn).toHaveBeenCalledWith(
      {
        reqId: 'req-1',
        method: 'GET',
        route: '/events/:eventId',
        statusCode: 200,
        responseTimeMs: 1500,
      },
      'slow request',
    );
  });

  it('loggar inte ett vanligt, snabbt anrop', async () => {
    const { logger, warn } = fakeLogger();
    await createSlowRequestHook(logger, 1000)(request, { statusCode: 200, elapsedTime: 12 });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('QuietRequestLogController', () => {
  async function appWithRoutes(logger: pino.Logger) {
    const app = Fastify({
      loggerInstance: logger,
      logController: new QuietRequestLogController(),
    });
    app.get('/ok', () => ({ ok: true }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    await app.ready();
    return app;
  }

  it('skriver ingen rad för ett vanligt anrop', async () => {
    const { logger, messages } = capturingLogger();
    const app = await appWithRoutes(logger);

    await app.inject({ method: 'GET', url: '/ok' });

    expect(messages()).not.toContain('incoming request');
    expect(messages()).not.toContain('request completed');
    await app.close();
  });

  it('loggar fortfarande ett 500-fel från standardfelhanteraren', async () => {
    const { logger, messages } = capturingLogger();
    const app = await appWithRoutes(logger);

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(messages()).toContain('kaboom');
    await app.close();
  });
});
