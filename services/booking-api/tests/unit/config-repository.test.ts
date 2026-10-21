import { describe, expect, it } from 'vitest';
import { parsePositiveInteger } from '../../src/repositories/config-repository.js';

describe('parsePositiveInteger', () => {
  it('parses a valid positive integer string', () => {
    expect(parsePositiveInteger('max_seats_per_reservation', '5')).toBe(5);
  });

  it('throws on a non-numeric value instead of silently becoming NaN', () => {
    // NaN would make `seatIds.length > maxSeatsPerReservation` always
    // false, silently disabling the max-seats-per-booking control.
    expect(() => parsePositiveInteger('max_seats_per_reservation', 'not-a-number')).toThrow(
      /not a positive integer/,
    );
  });

  it('throws on an empty string', () => {
    expect(() => parsePositiveInteger('max_seats_per_reservation', '')).toThrow();
  });

  it('throws on zero', () => {
    expect(() => parsePositiveInteger('max_seats_per_reservation', '0')).toThrow();
  });

  it('throws on a negative number', () => {
    expect(() => parsePositiveInteger('max_seats_per_reservation', '-5')).toThrow();
  });

  it('throws on a non-integer number', () => {
    expect(() => parsePositiveInteger('max_seats_per_reservation', '1.5')).toThrow();
  });
});
