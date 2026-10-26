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
  retries: process.env['CI'] === undefined ? 0 : 1,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
});
