/**
 * Den yttersta felhanteraren (docs/rules.md §5): mappar `BaseError` →
 * HTTP-svar, loggar fel EN gång här (inte i varje lager), och skiljer
 * operationella fel ("stolen är tagen", händer tusentals gånger) från
 * buggar (allt annat → 500 + loggrad markerad som bugg, larmbar).
 *
 * Felet loggas under `err`, pinos nyckel för fel: då kommer meddelande och
 * stack med. Under en annan nyckel blev ett vanligt `Error` bara `{}`.
 */
import { isConnectionTimeout } from '@tickets/db';
import { isBaseError, ServiceUnavailableError, toErrorResponseBody } from '@tickets/domain';
import type { FastifyInstance } from 'fastify';

/** Sekunder klienten ombeds vänta när databaspoolen är full. Kort: trycket släpper oftast inom en sekund. */
const OVERLOADED_RETRY_AFTER_SECONDS = '1';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isBaseError(error)) {
      if (error.isOperational) {
        request.log.warn({ code: error.code }, 'operational error');
      } else {
        request.log.error({ err: error }, 'non-operational domain error');
      }
      reply.code(error.httpStatus).send(toErrorResponseBody(error));
      return;
    }
    // Alla anslutningar till databasen var upptagna för länge: tillfällig överbelastning, inte en
    // bugg. 503 med Retry-After säger "försök igen" i stället för att larma som en bugg.
    if (isConnectionTimeout(error)) {
      request.log.warn({ err: error }, 'database connection pool exhausted');
      reply
        .code(503)
        .header('retry-after', OVERLOADED_RETRY_AFTER_SECONDS)
        .send(
          toErrorResponseBody(new ServiceUnavailableError('The service is busy, try again')),
        );
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
  });
}
