import { afterEach, describe, expect, it } from 'vitest';
import {
  clearQueueToken,
  getStoredQueueToken,
  storeQueueToken,
} from '../queue-token-storage.js';

const EVENT_ID = 'event-1';
const OTHER_EVENT_ID = 'event-2';

afterEach(() => {
  localStorage.clear();
});

describe('queue token storage', () => {
  it('returns undefined when nothing has been stored for the event', () => {
    expect(getStoredQueueToken(EVENT_ID)).toBeUndefined();
  });

  it('stores and reads back a token scoped to its own event', () => {
    storeQueueToken(EVENT_ID, 'token-a');
    storeQueueToken(OTHER_EVENT_ID, 'token-b');

    expect(getStoredQueueToken(EVENT_ID)).toBe('token-a');
    expect(getStoredQueueToken(OTHER_EVENT_ID)).toBe('token-b');
  });

  it('clears only the given event token', () => {
    storeQueueToken(EVENT_ID, 'token-a');
    storeQueueToken(OTHER_EVENT_ID, 'token-b');

    clearQueueToken(EVENT_ID);

    expect(getStoredQueueToken(EVENT_ID)).toBeUndefined();
    expect(getStoredQueueToken(OTHER_EVENT_ID)).toBe('token-b');
  });
});
