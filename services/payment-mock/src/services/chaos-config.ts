/**
 * Konfigurerbart kaos (docs/plan.md "Betalning": "payment-mock för
 * lasttest, med konfigurerbart kaos: slumpmässig latens, ~5 % fel,
 * dubbla webhooks, svar som anländer efter att reservationen löpt ut").
 * Allt läst från miljövariabler, inte hårdkodat — ett lasttest ska
 * kunna variera kaoset utan en ny image.
 */

export interface ChaosConfig {
  readonly latencyMinMs: number;
  readonly latencyMaxMs: number;
  readonly failureRate: number;
  readonly duplicateWebhookRate: number;
  /** Sannolikheten att webhooken dröjer långt förbi frysningsfönstret (docs/plan.md "Betalning som landar efter utgången reservation"). */
  readonly lateWebhookRate: number;
  readonly lateWebhookDelayMs: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function loadChaosConfig(): ChaosConfig {
  return {
    latencyMinMs: readNumber('PAYMENT_MOCK_LATENCY_MIN_MS', 50),
    latencyMaxMs: readNumber('PAYMENT_MOCK_LATENCY_MAX_MS', 2000),
    failureRate: readNumber('PAYMENT_MOCK_FAILURE_RATE', 0.05),
    duplicateWebhookRate: readNumber('PAYMENT_MOCK_DUPLICATE_WEBHOOK_RATE', 0.05),
    lateWebhookRate: readNumber('PAYMENT_MOCK_LATE_WEBHOOK_RATE', 0.02),
    lateWebhookDelayMs: readNumber('PAYMENT_MOCK_LATE_WEBHOOK_DELAY_MS', 11 * 60 * 1000),
  };
}

export function randomLatencyMs(config: ChaosConfig): number {
  return config.latencyMinMs + Math.random() * (config.latencyMaxMs - config.latencyMinMs);
}

export function rollBoolean(probability: number): boolean {
  return Math.random() < probability;
}
