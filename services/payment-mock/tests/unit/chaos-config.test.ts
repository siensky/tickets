import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadChaosConfig,
  randomLatencyMs,
  rollBoolean,
} from '../../src/services/chaos-config.js';

const ENV_KEYS = [
  'PAYMENT_MOCK_LATENCY_MIN_MS',
  'PAYMENT_MOCK_LATENCY_MAX_MS',
  'PAYMENT_MOCK_FAILURE_RATE',
  'PAYMENT_MOCK_DUPLICATE_WEBHOOK_RATE',
  'PAYMENT_MOCK_LATE_WEBHOOK_RATE',
  'PAYMENT_MOCK_LATE_WEBHOOK_DELAY_MS',
] as const;

describe('loadChaosConfig', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('uses sensible defaults matching docs/plan.md when nothing is set', () => {
    const config = loadChaosConfig();
    expect(config.failureRate).toBeCloseTo(0.05);
    expect(config.latencyMinMs).toBe(50);
  });

  it('reads overrides from the environment', () => {
    process.env['PAYMENT_MOCK_FAILURE_RATE'] = '0.5';
    const config = loadChaosConfig();
    expect(config.failureRate).toBe(0.5);
  });

  it('falls back to the default for a non-numeric override instead of producing NaN', () => {
    process.env['PAYMENT_MOCK_FAILURE_RATE'] = 'not-a-number';
    const config = loadChaosConfig();
    expect(config.failureRate).toBeCloseTo(0.05);
  });
});

describe('randomLatencyMs', () => {
  it('stays within the configured [min, max] range', () => {
    const config = { ...loadChaosConfig(), latencyMinMs: 100, latencyMaxMs: 200 };
    for (let i = 0; i < 50; i++) {
      const latency = randomLatencyMs(config);
      expect(latency).toBeGreaterThanOrEqual(100);
      expect(latency).toBeLessThanOrEqual(200);
    }
  });
});

describe('rollBoolean', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always returns false for probability 0', () => {
    expect(rollBoolean(0)).toBe(false);
  });

  it('always returns true for probability 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(rollBoolean(1)).toBe(true);
  });
});
