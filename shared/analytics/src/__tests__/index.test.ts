import { describe, expect, it } from 'vitest';
import { ANALYTICS_PACKAGE_NAME } from '../index.js';
import { ANALYTICS_SERVER_MARKER } from '../server.js';

describe('@tickets/analytics placeholder', () => {
  it('exports its package markers', () => {
    expect(ANALYTICS_PACKAGE_NAME).toBe('@tickets/analytics');
    expect(ANALYTICS_SERVER_MARKER).toBe('@tickets/analytics/server');
  });
});
