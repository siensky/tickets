/**
 * Placeholder so `test:integration` has something to run before Fas 2
 * adds real Testcontainers-backed tests (docs/rules.md §8: no mocked
 * databases in integration tests — real Postgres/Redis/RabbitMQ only).
 */
import { describe, expect, it } from 'vitest';
import { start } from '../../src/index.js';

describe('booking-api entrypoint', () => {
  it('exports a start function', () => {
    expect(typeof start).toBe('function');
  });
});
