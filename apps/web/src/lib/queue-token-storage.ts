/**
 * Queue-token persistence (docs/plan.md "Väntrum"): the token is the
 * only thing proving the user's place in the queue/their reservation,
 * so it survives a reload via localStorage, scoped per event — a
 * second tab on a different event must never reuse this one's token.
 */

function storageKey(eventId: string): string {
  return `tickets:queue-token:${eventId}`;
}

export function getStoredQueueToken(eventId: string): string | undefined {
  try {
    return localStorage.getItem(storageKey(eventId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeQueueToken(eventId: string, token: string): void {
  try {
    localStorage.setItem(storageKey(eventId), token);
  } catch {
    // Private browsing / full storage — the token still works for this
    // page load from memory, it just won't survive a reload.
  }
}

export function clearQueueToken(eventId: string): void {
  try {
    localStorage.removeItem(storageKey(eventId));
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}
