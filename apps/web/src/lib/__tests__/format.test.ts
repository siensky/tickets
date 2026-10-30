import { describe, expect, it } from 'vitest';
import {
  formatEventDate,
  formatPrice,
  formatPriceRange,
  getEventDateParts,
} from '../format.js';

const normalize = (value: string): string => value.replace(/\s/g, ' ');

describe('formatPrice', () => {
  it('formaterar öre som kronor med tusentalsavgränsare', () => {
    expect(normalize(formatPrice(118_500))).toBe('1 185 kr');
    expect(formatPrice(39_500)).toMatch(/^395\skr$/);
  });
});

describe('formatPriceRange', () => {
  it('visar ett enda pris när min och max är lika', () => {
    expect(normalize(formatPriceRange(50_000, 50_000))).toBe('500 kr');
  });

  it('visar intervall och tom sträng när pris saknas', () => {
    expect(normalize(formatPriceRange(39_500, 89_500))).toBe('395 kr – 895 kr');
    expect(formatPriceRange(null, null)).toBe('');
  });
});

describe('formatEventDate', () => {
  it('visar svensk tid oavsett UTC-tiden', () => {
    expect(formatEventDate('2026-11-27T19:00:00Z')).toBe('fre 27 nov 2026 · 20:00');
  });

  it('hanterar sommartid', () => {
    expect(getEventDateParts('2026-07-10T18:30:00Z').time).toBe('20:30');
  });
});
