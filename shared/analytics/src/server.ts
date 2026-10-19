/**
 * Server-side PostHog SDK wrapper. Critical conversion events
 * (payment_succeeded) are sent from here, not the browser — a closed tab
 * must not lose the event (docs/forsvar.md "Varför skickas
 * payment_succeeded från servern och inte webbläsaren?").
 *
 * Implemented in Fas 5.
 */
export const ANALYTICS_SERVER_MARKER = '@tickets/analytics/server';
