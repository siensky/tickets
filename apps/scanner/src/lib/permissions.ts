/**
 * Läser `permissions` ur access-tokenets payload. Bara för att välja rätt skärm i appen
 * ("Ditt konto har inte scannerbehörighet"): tokenet litas inte på här, booking-api verifierar
 * signatur och permission vid varje skanning (docs/plan.md 7.13 E7).
 */
export function readPermissions(accessToken: string): readonly string[] {
  try {
    const payload = accessToken.split('.')[1];
    if (payload === undefined) {
      return [];
    }
    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || !('permissions' in parsed)) {
      return [];
    }
    const { permissions } = parsed;
    return Array.isArray(permissions)
      ? permissions.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    // Ett token som inte går att läsa ger inga permissions: appen visar då "ingen behörighet".
    return [];
  }
}
