/**
 * Generic TypeScript types shared across services and apps that don't
 * belong to a Zod schema (branded IDs, utility types, etc.). Domain
 * errors live in @tickets/domain, request/response shapes in
 * @tickets/schemas — this package is for everything else shared.
 */

/** Branded string type so e.g. an EventId can't be passed where a SeatId is expected. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type EventId = Brand<string, 'EventId'>;
export type SeatId = Brand<string, 'SeatId'>;
export type UserId = Brand<string, 'UserId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type OrderId = Brand<string, 'OrderId'>;
