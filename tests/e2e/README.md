# tests/e2e

Playwright mot en riktig stack (docs/plan.md 7.15). Körs i pipelinen vid varje merge (G-krav).

- `booking-flow.spec.ts`: startsida → event → kö → karta → reservation → riktig Auth0-inloggning → betalning mot payment-mock → bekräftelse → QR.
- `keyboard-booking`, `mobile-booking` (375 × 812), `reservation-expiry`, `seat-taken`, `a11y` (axe).
- `seed.ts` skapar en arena och ett event per spec (`E2E_EVENTS`); `helpers/` har kö-, config- och stegfunktioner.
- Specarna delar databas och Redis, därför `workers: 1`.
