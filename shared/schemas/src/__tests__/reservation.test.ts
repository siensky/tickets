import { describe, expect, it } from 'vitest';
import { createReservationRequestSchema } from '../reservation.js';

const SEAT_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('createReservationRequestSchema', () => {
  it('accepts between 1 and 5 seat ids', () => {
    expect(createReservationRequestSchema.safeParse({ seatIds: [SEAT_ID] }).success).toBe(
      true,
    );
  });

  it('rejects an empty seatIds array', () => {
    expect(createReservationRequestSchema.safeParse({ seatIds: [] }).success).toBe(false);
  });

  it('rejects more than 5 seat ids', () => {
    const seatIds = Array.from({ length: 6 }, () => SEAT_ID);
    expect(createReservationRequestSchema.safeParse({ seatIds }).success).toBe(false);
  });

  it('rejects an unknown extra field (strict mode)', () => {
    const result = createReservationRequestSchema.safeParse({
      seatIds: [SEAT_ID],
      priceCents: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID seat id', () => {
    expect(createReservationRequestSchema.safeParse({ seatIds: ['not-a-uuid'] }).success).toBe(
      false,
    );
  });
});
