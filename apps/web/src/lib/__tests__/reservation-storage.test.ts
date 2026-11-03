import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLastReservationId,
  getLastReservationId,
  storeLastReservationId,
} from '../reservation-storage.js';

afterEach(() => sessionStorage.clear());

describe('reservation-storage', () => {
  it('glömmer flikens reservation', () => {
    storeLastReservationId('e1', 'r1');
    clearLastReservationId('e1');
    expect(getLastReservationId('e1')).toBeUndefined();
  });

  it('ett sent svar för en äldre reservation suddar aldrig ut en nyare', () => {
    storeLastReservationId('e1', 'r2');
    clearLastReservationId('e1', 'r1');
    expect(getLastReservationId('e1')).toBe('r2');

    clearLastReservationId('e1', 'r2');
    expect(getLastReservationId('e1')).toBeUndefined();
  });
});
