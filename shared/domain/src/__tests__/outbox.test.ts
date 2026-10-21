import { describe, expect, it } from 'vitest';
import { OUTBOX_EVENT_TYPES, OUTBOX_EXCHANGE } from '../outbox.js';

describe('outbox vocabulary', () => {
  it('exposes the exchange name and known event types', () => {
    expect(OUTBOX_EXCHANGE).toBe('domain-events');
    expect(OUTBOX_EVENT_TYPES.RESERVATION_CREATED).toBe('reservation.created');
  });
});
