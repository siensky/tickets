import { describe, expect, it } from 'vitest';
import {
  computeAvailability,
  computeSeatAvailability,
} from '../../src/services/event-availability.js';

const OPEN_EVENT = {
  status: 'scheduled',
  isBeforeOpen: false,
  isAfterClose: false,
  availableSeats: 500,
  totalSeats: 1000,
};

describe('computeAvailability', () => {
  it('är closed när eventet inte är scheduled', () => {
    expect(computeAvailability({ ...OPEN_EVENT, status: 'cancelled' })).toBe('closed');
  });

  it('är closed när försäljningen har stängt, även om stolar finns kvar', () => {
    expect(computeAvailability({ ...OPEN_EVENT, isAfterClose: true })).toBe('closed');
  });

  it('är opens_soon före öppningstid', () => {
    expect(computeAvailability({ ...OPEN_EVENT, isBeforeOpen: true })).toBe('opens_soon');
  });

  it('är sold_out utan lediga stolar', () => {
    expect(computeAvailability({ ...OPEN_EVENT, availableSeats: 0 })).toBe('sold_out');
  });

  it('är on_sale annars', () => {
    expect(computeAvailability(OPEN_EVENT)).toBe('on_sale');
  });
});

describe('computeSeatAvailability', () => {
  it('är few_left exakt på gränsen max(10, 10 % av stolarna) och on_sale en över', () => {
    expect(computeSeatAvailability(100, 1000)).toBe('few_left');
    expect(computeSeatAvailability(101, 1000)).toBe('on_sale');
  });

  it('använder minst 10 stolar som gräns för små arenor', () => {
    expect(computeSeatAvailability(10, 60)).toBe('few_left');
    expect(computeSeatAvailability(11, 60)).toBe('on_sale');
  });

  it('avrundar 10 % uppåt', () => {
    expect(computeSeatAvailability(12, 111)).toBe('few_left');
    expect(computeSeatAvailability(13, 111)).toBe('on_sale');
  });

  it('är sold_out vid noll lediga', () => {
    expect(computeSeatAvailability(0, 60)).toBe('sold_out');
  });
});
