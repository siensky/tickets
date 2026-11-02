/**
 * Playwright config (docs/plan.md fasplan Fas 5: "G: e2e i pipeline").
 * Does NOT start Postgres/Redis/booking-api/web itself — the CI job
 * (.github/workflows/e2e.yml) starts and seeds those first, the same
 * services docker-compose.yml already defines for local dev. `baseURL`
 * points at the already-running web app.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  // En worker: reservation-expiry.spec.ts sätter hålltiden till en minut i `config` en stund, och
  // alla specar delar databas och Redis. Sviten är liten.
  workers: 1,
  retries: process.env['CI'] === undefined ? 0 : 1,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    // PostHog filtrerar bort headless-webbläsare ("HeadlessChrome" i user-agent) som botar och
    // skickar då inga händelser, vilket e2e-testen av /ingest (docs/plan.md 7.15) förutsätter.
    // (navigator.webdriver åtgärdas i helpers/posthog.ts.)
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
});
