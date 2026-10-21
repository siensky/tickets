import { describe, expect, it } from 'vitest';
import {
  findUnavailableSeatIds,
  validateSeatCount,
} from '../../src/services/seat-availability.js';
import type { SeatLockRow } from '../../src/types/reservation.js';

describe('validateSeatCount', () => {
  it('accepts a request within the max', () => {
    expect(() => validateSeatCount(['s1', 's2'], 5)).not.toThrow();
  });

  it('rejects zero seats', () => {
    expect(() => validateSeatCount([], 5)).toThrow('At least one seat is required');
  });

  it('rejects more seats than the configured max', () => {
    expect(() => validateSeatCount(['s1', 's2', 's3'], 2)).toThrow(/At most 2 seats/);
  });

  it('rejects duplicate seat ids in the same request', () => {
    expect(() => validateSeatCount(['s1', 's1'], 5)).toThrow(/Duplicate seat ids/);
  });
});

describe('findUnavailableSeatIds', () => {
  function row(
    seatId: string,
    seatStatus: string,
    reservationId: string | null = null,
  ): SeatLockRow {
    return { seatId, seatStatus, reservationId };
  }

  it('treats already-available seats as available', () => {
    expect(findUnavailableSeatIds([row('s1', 'available')], [])).toEqual([]);
  });

  it('treats a held seat as unavailable when it was not released', () => {
    expect(findUnavailableSeatIds([row('s1', 'held', 'r1')], [])).toEqual(['s1']);
  });

  it('treats a held seat as available once lazy expiry released it', () => {
    expect(findUnavailableSeatIds([row('s1', 'held', 'r1')], ['s1'])).toEqual([]);
  });

  it('treats a sold seat as unavailable', () => {
    // A sold seat can never appear in `releasedSeatIds` in practice —
    // releaseExpiredSeatsAmong only ever matches status = 'held' — so
    // there's no "released" variant of this case to test.
    expect(findUnavailableSeatIds([row('s1', 'sold')], [])).toEqual(['s1']);
  });

  it('reports only the still-unavailable seats out of a mixed batch', () => {
    const rows = [
      row('s1', 'available'),
      row('s2', 'held', 'r1'),
      row('s3', 'held', 'r2'),
      row('s4', 'sold'),
    ];
    expect(findUnavailableSeatIds(rows, ['s2'])).toEqual(['s3', 's4']);
  });
});
