/**
 * Pact-konsumenttesterna körs separat från enhetstesterna (`pnpm test:pact`):
 * de skriver pact-filer till `pacts/` i repo-roten, som booking-api verifierar.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/contract/**/*.pact.test.ts'] },
});
