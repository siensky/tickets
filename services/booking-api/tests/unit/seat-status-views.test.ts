import { describe, expect, it } from 'vitest';
import { seatListVersion, toSeatStatusBody } from '../../src/services/seat-status-views.js';
import type { SeatStatusRow } from '../../src/types/seatmap.js';

const HELD_UNTIL = new Date('2030-01-01T12:05:00.000Z');

const AVAILABLE: SeatStatusRow = {
  id: 'a1',
  venueSeatId: 'v1',
  status: 'available',
  priceCents: 39_500,
  heldUntil: null,
};
const HELD: SeatStatusRow = {
  id: 'b2',
  venueSeatId: 'v2',
  status: 'held',
  priceCents: 49_500,
  heldUntil: HELD_UNTIL,
};
const SOLD: SeatStatusRow = {
  id: 'c3',
  venueSeatId: 'v3',
  status: 'sold',
  priceCents: 39_500,
  heldUntil: null,
};
/** Tre stolar i den ordning repositoryt ger dem (sorterade på id). */
const ROWS: readonly SeatStatusRow[] = [AVAILABLE, HELD, SOLD];

describe('toSeatStatusBody', () => {
  it('full: samma svar som stolsstatusen alltid haft', () => {
    expect(JSON.parse(toSeatStatusBody(ROWS, 'full'))).toEqual({
      seats: [
        {
          seatId: 'a1',
          venueSeatId: 'v1',
          status: 'available',
          priceCents: 39_500,
          heldUntil: null,
        },
        {
          seatId: 'b2',
          venueSeatId: 'v2',
          status: 'held',
          priceCents: 49_500,
          heldUntil: '2030-01-01T12:05:00.000Z',
        },
        {
          seatId: 'c3',
          venueSeatId: 'v3',
          status: 'sold',
          priceCents: 39_500,
          heldUntil: null,
        },
      ],
    });
  });

  it('catalog: id och pris i samma ordning, utan status', () => {
    expect(JSON.parse(toSeatStatusBody(ROWS, 'catalog'))).toEqual({
      version: seatListVersion(ROWS),
      seats: [
        { seatId: 'a1', venueSeatId: 'v1', priceCents: 39_500 },
        { seatId: 'b2', venueSeatId: 'v2', priceCents: 49_500 },
        { seatId: 'c3', venueSeatId: 'v3', priceCents: 39_500 },
      ],
    });
  });

  it('compact: ett tecken per stol och utgångstiden per position', () => {
    expect(JSON.parse(toSeatStatusBody(ROWS, 'compact'))).toEqual({
      version: seatListVersion(ROWS),
      statuses: 'ahs',
      heldUntil: [{ index: 1, until: '2030-01-01T12:05:00.000Z' }],
    });
  });

  it('compact: en hållen stol i betalning (ingen utgångstid) står som h utan heldUntil', () => {
    const inPayment: SeatStatusRow[] = [{ ...AVAILABLE, status: 'held', heldUntil: null }];

    expect(JSON.parse(toSeatStatusBody(inPayment, 'compact'))).toMatchObject({
      statuses: 'h',
      heldUntil: [],
    });
  });
});

describe('seatListVersion', () => {
  it('är densamma när bara statusen ändras', () => {
    const allSold = ROWS.map((row) => ({ ...row, status: 'sold' as const, heldUntil: null }));

    expect(seatListVersion(allSold)).toBe(seatListVersion(ROWS));
  });

  it('ändras när en stol läggs till eller tas bort', () => {
    expect(seatListVersion(ROWS.slice(0, 2))).not.toBe(seatListVersion(ROWS));
  });

  it('skiljer på id:n som bara slås ihop olika', () => {
    const ab = [
      { ...AVAILABLE, id: 'ab' },
      { ...HELD, id: 'c' },
    ];
    const abc = [
      { ...AVAILABLE, id: 'a' },
      { ...HELD, id: 'bc' },
    ];

    expect(seatListVersion(ab)).not.toBe(seatListVersion(abc));
  });
});
