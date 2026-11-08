import { describe, expect, it } from 'vitest';
import {
  MAX_POLL_SECONDS,
  MIN_POLL_SECONDS,
  nextPollSeconds,
} from '../../src/services/queue-poll-interval.js';

describe('nextPollSeconds', () => {
  it('låter den som snart är framme fråga med minsta intervallet', () => {
    expect(nextPollSeconds(10, 3600)).toBe(MIN_POLL_SECONDS);
  });

  it('ger en fjärdedel av den beräknade väntan mellan gränserna', () => {
    // 3600/min = 60/s: plats 4 800 är framme om 80 s, alltså fråga om 20 s.
    expect(nextPollSeconds(4800, 3600)).toBe(20);
  });

  it('låter den som står långt bak fråga sällan, aldrig mer sällan än taket', () => {
    expect(nextPollSeconds(50_000, 300)).toBe(MAX_POLL_SECONDS);
  });

  it('faller tillbaka på taket om insläppstakten inte är positiv', () => {
    expect(nextPollSeconds(10, 0)).toBe(MAX_POLL_SECONDS);
  });
});
