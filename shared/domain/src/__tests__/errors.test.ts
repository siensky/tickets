import { describe, expect, it } from 'vitest';
import {
  ActiveReservationExistsError,
  BaseError,
  ConflictError,
  ForbiddenError,
  GoneError,
  IdempotencyConflictError,
  InternalError,
  NotFoundError,
  QueueTokenInvalidError,
  QueueTokenNotAdmittedError,
  ReservationExpiredError,
  ReservationNotInExpectedStatusError,
  SalesClosedError,
  SalesNotOpenError,
  SeatUnavailableError,
  ShardUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  isBaseError,
  toErrorResponseBody,
} from '../errors.js';

describe('BaseError hierarchy', () => {
  it('sets httpStatus and isOperational per family', () => {
    const conflict = new ConflictError('taken');
    expect(conflict.httpStatus).toBe(409);
    expect(conflict.isOperational).toBe(true);

    const internal = new InternalError('boom');
    expect(internal.httpStatus).toBe(500);
    expect(internal.isOperational).toBe(false);
  });

  it('isBaseError narrows unknown caught values', () => {
    const thrown: unknown = new SeatUnavailableError(['seat-1']);
    expect(isBaseError(thrown)).toBe(true);
    expect(isBaseError(new Error('plain'))).toBe(false);
  });

  it('domain errors carry a specific code and context', () => {
    const error = new SeatUnavailableError(['seat-1', 'seat-2']);
    expect(error.code).toBe('SEAT_UNAVAILABLE');
    expect(error.context).toEqual({ seatIds: ['seat-1', 'seat-2'] });
    expect(error instanceof ConflictError).toBe(true);
  });

  it('toErrorResponseBody serializes a consistent shape', () => {
    const error = new ReservationExpiredError('res-123');
    expect(toErrorResponseBody(error)).toEqual({
      error: {
        code: 'RESERVATION_EXPIRED',
        message: 'Reservation res-123 has expired',
        context: { reservationId: 'res-123' },
      },
    });
  });

  it('IdempotencyConflictError and ShardUnavailableError map to the right family', () => {
    expect(new IdempotencyConflictError('key-1').httpStatus).toBe(409);
    expect(new ShardUnavailableError(1).httpStatus).toBe(500);
    expect(new ShardUnavailableError(1).isOperational).toBe(false);
  });

  it('ActiveReservationExistsError maps to 409 and carries the queue token', () => {
    const error = new ActiveReservationExistsError('queue-token-1');
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('ACTIVE_RESERVATION_EXISTS');
    expect(error.context).toEqual({ queueTokenId: 'queue-token-1' });
    expect(error instanceof ConflictError).toBe(true);
  });

  it('QueueTokenInvalidError carries the invalidation reason', () => {
    const error = new QueueTokenInvalidError('expired');
    expect(error.code).toBe('QUEUE_TOKEN_INVALID');
    expect(error.httpStatus).toBe(401);
    expect(error.context).toEqual({ reason: 'expired' });
  });

  it('toErrorResponseBody omits context when none was given', () => {
    const error = new ValidationError('bad input');
    expect(toErrorResponseBody(error)).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'bad input' },
    });
  });

  it('QueueTokenNotAdmittedError maps to 403 and carries the queue token', () => {
    const error = new QueueTokenNotAdmittedError('queue-token-1');
    expect(error.httpStatus).toBe(403);
    expect(error.code).toBe('QUEUE_TOKEN_NOT_ADMITTED');
    expect(error.context).toEqual({ queueTokenId: 'queue-token-1' });
    expect(error instanceof ForbiddenError).toBe(true);
  });

  it('SalesNotOpenError maps to 403 and carries the event id and open time', () => {
    const error = new SalesNotOpenError('event-1', '2026-11-01T00:00:00.000Z');
    expect(error.httpStatus).toBe(403);
    expect(error.code).toBe('SALES_NOT_OPEN');
    expect(error.context).toEqual({
      eventId: 'event-1',
      salesOpenAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('SalesClosedError maps to 410 and carries the event id', () => {
    const error = new SalesClosedError('event-1');
    expect(error.httpStatus).toBe(410);
    expect(error.code).toBe('SALES_CLOSED');
    expect(error.context).toEqual({ eventId: 'event-1' });
    expect(error instanceof GoneError).toBe(true);
  });

  it('ReservationNotInExpectedStatusError maps to 409 and carries both statuses', () => {
    const error = new ReservationNotInExpectedStatusError(
      'res-1',
      'active',
      'pending_payment',
    );
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('RESERVATION_NOT_IN_EXPECTED_STATUS');
    expect(error.context).toEqual({
      reservationId: 'res-1',
      expectedStatus: 'active',
      actualStatus: 'pending_payment',
    });
    expect(error instanceof ConflictError).toBe(true);
  });

  it.each([
    [ValidationError, 400, 'VALIDATION_ERROR'],
    [UnauthorizedError, 401, 'UNAUTHORIZED'],
    [ForbiddenError, 403, 'FORBIDDEN'],
    [NotFoundError, 404, 'NOT_FOUND'],
    [GoneError, 410, 'GONE'],
    [TooManyRequestsError, 429, 'TOO_MANY_REQUESTS'],
  ] as const)(
    '%s has the expected httpStatus and default code',
    (ErrorClass, httpStatus, code) => {
      const error = new ErrorClass('message');
      expect(error.httpStatus).toBe(httpStatus);
      expect(error.isOperational).toBe(true);
      expect(error.code).toBe(code);
      expect(error instanceof BaseError).toBe(true);
    },
  );
});
