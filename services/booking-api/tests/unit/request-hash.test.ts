import { describe, expect, it } from 'vitest';
import { computeRequestHash } from '../../src/services/request-hash.js';
import type { ReserveSeatsInput } from '../../src/types/reservation.js';

function input(overrides: Partial<ReserveSeatsInput> = {}): ReserveSeatsInput {
  return {
    eventId: 'event-1',
    seatIds: ['seat-1', 'seat-2'],
    queueTokenId: 'queue-1',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

describe('computeRequestHash', () => {
  it('is deterministic for the same input', () => {
    expect(computeRequestHash(input())).toBe(computeRequestHash(input()));
  });

  it('is identical regardless of seat id order — [5, 9] and [9, 5] are the same request', () => {
    const a = computeRequestHash(input({ seatIds: ['seat-5', 'seat-9'] }));
    const b = computeRequestHash(input({ seatIds: ['seat-9', 'seat-5'] }));
    expect(a).toBe(b);
  });

  it('differs when the event differs', () => {
    expect(computeRequestHash(input({ eventId: 'event-2' }))).not.toBe(
      computeRequestHash(input()),
    );
  });

  it('differs when the queue token differs', () => {
    expect(computeRequestHash(input({ queueTokenId: 'queue-2' }))).not.toBe(
      computeRequestHash(input()),
    );
  });

  it('differs when the seat selection differs', () => {
    expect(computeRequestHash(input({ seatIds: ['seat-3'] }))).not.toBe(
      computeRequestHash(input()),
    );
  });

  it('does NOT depend on the idempotency key itself', () => {
    // The hash is what detects "same key, different body" — if it
    // factored in the key, every call would trivially be a match.
    expect(computeRequestHash(input({ idempotencyKey: 'different-key' }))).toBe(
      computeRequestHash(input()),
    );
  });
});
