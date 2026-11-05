/**
 * Sparsam loggning av anrop (docs/loadtest-cpu-plan.md steg 2). Fastifys egna rader per anrop
 * ("incoming request" + "request completed") tas bort med `QuietRequestLogController`, och bara anrop
 * som tar längre tid än tröskeln loggas av `createSlowRequestHook`. Antalet anrop, status och
 * svarstider finns i Prometheus (RED-måtten). Vid tusentals anrop per sekund var loggraderna en av de
 * största CPU-kostnaderna: varje rad maskeras, skrivs, läses av Alloy och lagras i Loki.
 *
 * Fastifys `disableRequestLogging` används inte: den tystar också felloggningen (5xx från
 * standardfelhanteraren, stream- och serialiseringsfel) och är utfasad i Fastify 5.
 */
import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from './logger.js';

export const SLOW_REQUEST_THRESHOLD_MS = 1000;

/**
 * Tar bort raden när ett anrop kommer in och raden när det lyckats. Allt annat är Fastifys standard:
 * fel (5xx), anrop som avbröts med ett fel, stream-, header- och serialiseringsfel loggas som förut.
 */
export class QuietRequestLogController extends LogController {
  override incomingRequest(): void {
    // Avsiktligt tom: ingen rad per anrop.
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (error) {
      super.requestCompleted(error, request, reply);
    }
  }
}

/** Det hooken läser ur Fastifys request och reply. */
export interface LoggedRequest {
  readonly id: string;
  readonly method: string;
  readonly routeOptions: { readonly url?: string };
}

export interface LoggedReply {
  readonly statusCode: number;
  readonly elapsedTime: number;
}

/** `onResponse`-hook: loggar bara anrop som tog längre tid än `thresholdMs`. */
export function createSlowRequestHook(
  logger: Logger,
  thresholdMs: number = SLOW_REQUEST_THRESHOLD_MS,
): (request: LoggedRequest, reply: LoggedReply) => Promise<void> {
  return (request, reply) => {
    if (reply.elapsedTime >= thresholdMs) {
      logger.warn(
        {
          reqId: request.id,
          method: request.method,
          route: request.routeOptions.url ?? 'unmatched',
          statusCode: reply.statusCode,
          responseTimeMs: Math.round(reply.elapsedTime),
        },
        'slow request',
      );
    }
    return Promise.resolve();
  };
}
