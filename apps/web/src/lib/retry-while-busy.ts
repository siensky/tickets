/**
 * Försöker igen när API:et svarar 503 ("upptaget, försök igen"). Det svarar booking-api när alla
 * databasanslutningar är upptagna, vilket bara händer i den värsta toppen av en försäljning. Utan nya
 * försök fastnade just de besökare som kom in i toppen på ett felmeddelande i stället för i kön.
 *
 * Bara 503: alla andra fel (stängd försäljning, botskydd, nätverksfel) går direkt till anroparen.
 * Väntetiden växer och slumpas lite, så att alla som fick 503 samtidigt inte kommer tillbaka samtidigt.
 */
import { ApiError } from './api-client.js';

export interface RetryWhileBusyOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  /** Sant när anroparen inte längre bryr sig (sidan lämnad): då görs inga fler försök. */
  readonly isCancelled?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusy(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

export async function retryWhileBusy<T>(
  run: () => Promise<T>,
  options: RetryWhileBusyOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isBusy(error) || attempt >= attempts || options.isCancelled?.() === true) {
        throw error;
      }
      await sleep(baseDelayMs * attempt + Math.random() * baseDelayMs);
    }
  }
}
