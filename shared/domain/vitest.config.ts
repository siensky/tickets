import { defineConfig } from 'vitest/config';

// rules.md §0: 90% coverage required on shared/domain and shared/db.
export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
