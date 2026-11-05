import { createLogger } from '@tickets/observability';
import { SeatUnavailableError } from '@tickets/domain';
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/routes/error-handler.js';

/** En app med felhanteraren och en route som kastar det testet ger den, plus loggraderna som JSON. */
async function appThrowing(error: unknown) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  // Samma typparametrar som src/index.ts: pinos Logger ska ses som Fastifys basloggare.
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({
    loggerInstance: createLogger({ serviceName: 'booking-api', level: 'info' }, stream),
  });
  registerErrorHandler(app);
  app.get('/boom', () => {
    throw error;
  });
  await app.ready();
  return { app, lines };
}

describe('registerErrorHandler', () => {
  it('svarar 503 med Retry-After när databaspoolen är full, och loggar orsaken', async () => {
    const { app, lines } = await appThrowing(
      new Error('timeout exceeded when trying to connect'),
    );

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    const logged = lines.find((line) => line['msg'] === 'database connection pool exhausted');
    expect(logged?.['err']).toMatchObject({
      message: 'timeout exceeded when trying to connect',
    });
    await app.close();
  });

  it('svarar 500 på ett okänt fel och loggar meddelandet, inte {}', async () => {
    const { app, lines } = await appThrowing(new Error('something unexpected'));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
    });
    const logged = lines.find((line) => line['msg'] === 'unhandled error');
    expect(logged?.['err']).toMatchObject({ message: 'something unexpected' });
    await app.close();
  });

  it('svarar med domänfelets egen status', async () => {
    const { app } = await appThrowing(new SeatUnavailableError(['s1']));

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
