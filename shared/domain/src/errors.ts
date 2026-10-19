/**
 * Base error hierarchy for the whole system (docs/rules.md §5). Every
 * domain error thrown anywhere in the backend extends `BaseError`, so the
 * outermost error handler in each service can always read `httpStatus`,
 * `code` and `isOperational` without guessing the shape of what it caught.
 *
 * `isOperational` is what makes alerts useful. An operational error (a
 * seat already being taken, say) is expected — it happens thousands of
 * times during a sale — and must NOT page anyone. A non-operational error
 * is a bug and should alert immediately. Without this split the alert
 * channel turns into noise nobody reads, which is worse than no alerts
 * (see docs/forsvar.md "Varför bygger vi egen felhierarki").
 */
export abstract class BaseError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly isOperational: boolean;
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  protected constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.context = context;
    Error.captureStackTrace?.(this, new.target);
  }
}

// --- HTTP-status-named families (rules.md §5) -----------------------------
// Each is directly throwable with a generic `code`, and can be subclassed
// to carry a more specific `code` and typed `context` for a given failure.

export class ValidationError extends BaseError {
  readonly httpStatus = 400;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'VALIDATION_ERROR') {
    super(code, message, context);
  }
}

export class UnauthorizedError extends BaseError {
  readonly httpStatus = 401;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'UNAUTHORIZED') {
    super(code, message, context);
  }
}

export class ForbiddenError extends BaseError {
  readonly httpStatus = 403;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'FORBIDDEN') {
    super(code, message, context);
  }
}

export class NotFoundError extends BaseError {
  readonly httpStatus = 404;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'NOT_FOUND') {
    super(code, message, context);
  }
}

export class ConflictError extends BaseError {
  readonly httpStatus = 409;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'CONFLICT') {
    super(code, message, context);
  }
}

export class GoneError extends BaseError {
  readonly httpStatus = 410;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'GONE') {
    super(code, message, context);
  }
}

export class TooManyRequestsError extends BaseError {
  readonly httpStatus = 429;
  readonly isOperational = true;
  constructor(message: string, context?: Record<string, unknown>, code = 'TOO_MANY_REQUESTS') {
    super(code, message, context);
  }
}

/** Reaching this class means something unexpected broke — isOperational=false, always alert. */
export class InternalError extends BaseError {
  readonly httpStatus = 500;
  readonly isOperational = false;
  constructor(message: string, context?: Record<string, unknown>, code = 'INTERNAL_ERROR') {
    super(code, message, context);
  }
}

// --- Domain-specific errors (docs/plan.md "Databas" / concurrency core) --
// These are the ones services actually throw; reuse them across services
// instead of inventing a new error type per call site (rules.md §10).

/** Thrown when one or more selected seats were already taken by the time the lock was acquired. */
export class SeatUnavailableError extends ConflictError {
  constructor(seatIds: readonly string[]) {
    super(
      `${seatIds.length} seat(s) already unavailable: ${seatIds.join(', ')}`,
      { seatIds },
      'SEAT_UNAVAILABLE',
    );
  }
}

/** Thrown when a reservation's 5-minute hold has expired (lazy-expiry check, docs/plan.md). */
export class ReservationExpiredError extends GoneError {
  constructor(reservationId: string) {
    super(
      `Reservation ${reservationId} has expired`,
      { reservationId },
      'RESERVATION_EXPIRED',
    );
  }
}

/** Thrown when a waiting-room queue token is missing, expired, or fails signature verification. */
export class QueueTokenInvalidError extends UnauthorizedError {
  constructor(reason: string) {
    super(`Queue token invalid: ${reason}`, { reason }, 'QUEUE_TOKEN_INVALID');
  }
}

/** Thrown when an idempotency key is reused with a different request body than the original. */
export class IdempotencyConflictError extends ConflictError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was already used with a different request`,
      { idempotencyKey },
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

/** Thrown when a Postgres shard cannot be reached (docs/plan.md "shard-failure" load scenario). */
export class ShardUnavailableError extends InternalError {
  constructor(shard: number) {
    super(`Shard ${shard} is unavailable`, { shard }, 'SHARD_UNAVAILABLE');
  }
}

// --- Helpers used by the outermost error handler (rules.md §5) -----------

/** Narrows `unknown` (whatever a catch block caught) down to `BaseError`. */
export function isBaseError(error: unknown): error is BaseError {
  return error instanceof BaseError;
}

export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly context?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Maps a BaseError to the JSON body every service returns on failure, so
 * API error shapes stay identical across booking-api, realtime-gateway,
 * etc. Never pass an `InternalError`'s raw message to this in production
 * if it might contain internals you don't want to expose — construct
 * InternalError with a safe, generic message instead.
 */
export function toErrorResponseBody(error: BaseError): ErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.context ? { context: error.context } : {}),
    },
  };
}
