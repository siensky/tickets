/**
 * Väntar på ett villkor genom att polla det (docs/rules.md §8: aldrig
 * `sleep`). `expectStable` är undantaget som bevisar att något INTE
 * händer: villkoret ska hålla vid varje poll under hela perioden.
 */
const POLL_INTERVAL_MS = 200;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for: ${description}`);
    }
    await pause(POLL_INTERVAL_MS);
  }
}

export async function expectStable(
  description: string,
  holds: () => Promise<boolean>,
  durationMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    if (!(await holds())) {
      throw new Error(`Condition stopped holding: ${description}`);
    }
    await pause(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
}
