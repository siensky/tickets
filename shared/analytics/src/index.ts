/**
 * Typed PostHog event definitions — the single source of truth for event
 * names/payloads, consumed by apps/web, apps/scanner, and ./server.ts
 * (docs/plan.md "Produktanalys (PostHog)"). Keeping event names here
 * instead of scattered posthog.capture() calls is what keeps the funnel
 * analyzable.
 *
 * Implemented in Fas 5. Package scaffolded now so the workspace layout
 * is final from day one.
 */
export const ANALYTICS_PACKAGE_NAME = '@tickets/analytics';
