/**
 * Debounce för skanningar (docs/plan.md 7.8): samma kod skannas inte om inom `windowMs`, så att
 * en biljett som hålls kvar framför kameran inte blir en andra skanning direkt. En annan kod
 * släpps igenom direkt. Rent state: `now` skickas in, så det går att testa utan timers.
 */
export interface ScanDebouncer {
  /** `true` om koden ska skickas; registrerar den då som senast skannade. */
  accept(code: string, now: number): boolean;
  /** Glöm senaste koden, t.ex. när skanningen misslyckades och ska kunna göras om direkt. */
  reset(): void;
}

export function createScanDebouncer(windowMs: number): ScanDebouncer {
  let lastCode: string | undefined;
  let lastAcceptedAt = 0;
  return {
    accept(code, now) {
      if (code === lastCode && now - lastAcceptedAt < windowMs) {
        return false;
      }
      lastCode = code;
      lastAcceptedAt = now;
      return true;
    },
    reset() {
      lastCode = undefined;
    },
  };
}
