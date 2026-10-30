import { describe, expect, it } from 'vitest';
import { sumSeatPrices } from '../../src/services/pricing.js';

describe('sumSeatPrices', () => {
  it('summerar stolspriserna i öre', () => {
    expect(sumSeatPrices([{ priceCents: 39500 }, { priceCents: 69500 }])).toBe(109000);
  });

  it('ger 0 för en tom lista', () => {
    expect(sumSeatPrices([])).toBe(0);
  });
});
