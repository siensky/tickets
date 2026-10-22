/**
 * Den yttersta felhanteraren (docs/rules.md §5): mappar `BaseError` →
 * HTTP-svar, loggar fel EN gång här (inte i varje lager), och skiljer
 * operationella fel ("stolen är tagen", händer tusentals gånger) från
 * buggar (allt annat → 500 + loggrad markerad som bugg, larmbar).
 */
import { isBaseError, toErrorResponseBody } from '@tickets/domain';
import type { FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isBaseError(error)) {
      if (error.isOperational) {
        request.log.warn({ code: error.code }, 'operational error');
      } else {
        request.log.error({ error }, 'non-operational domain error');
      }
      reply.code(error.httpStatus).send(toErrorResponseBody(error));
      return;
    }
    request.log.error({ error }, 'unhandled error');
    reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
  });
}
