/**
 * Tar bort parametrar som aldrig får hamna i analytics (docs/rules.md §6, docs/plan.md 7.7):
 * Auth0:s återkomst (`code`, `state`, felparametrar) och söktexten `q`, som är fritext och kan
 * innehålla namn eller e-post. Allt annat i URL:en lämnas orört.
 */
const STRIPPED_PARAMS = ['code', 'state', 'error', 'error_description', 'q'] as const;

export function sanitizeUrl(value: string): string {
  if (!URL.canParse(value)) {
    return value;
  }
  const url = new URL(value);
  for (const param of STRIPPED_PARAMS) {
    url.searchParams.delete(param);
  }
  return url.toString();
}

const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
] as const;

/** `before_send` för posthog-js: rensar URL-egenskaperna på varje händelse. */
export function sanitizeEventUrls<T extends { properties?: Record<string, unknown> } | null>(
  event: T,
): T {
  if (event?.properties === undefined) {
    return event;
  }
  for (const key of URL_PROPERTIES) {
    const value = event.properties[key];
    if (typeof value === 'string') {
      event.properties[key] = sanitizeUrl(value);
    }
  }
  return event;
}
