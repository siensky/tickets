import { afterEach, describe, expect, it } from 'vitest';
import { getConsent, storeConsent } from '../consent.js';

afterEach(() => window.localStorage.clear());

describe('consent', () => {
  it('är "unset" innan användaren valt', () => {
    expect(getConsent()).toBe('unset');
  });

  it('kommer ihåg ett godkännande och ett nekande', () => {
    storeConsent('granted');
    expect(getConsent()).toBe('granted');
    storeConsent('denied');
    expect(getConsent()).toBe('denied');
  });

  it('behandlar ett okänt sparat värde som "unset"', () => {
    window.localStorage.setItem('tikknet:analytics-consent', 'kanske');
    expect(getConsent()).toBe('unset');
  });
});
