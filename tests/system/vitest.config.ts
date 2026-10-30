/**
 * Systemtesterna delar en och samma stack (och F5 ändrar en global config-
 * rad), så filerna körs en i taget. Tidsgränserna rymmer F5, som väntar på
 * att en reservation med 1 minuts hållning ska gå ut.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['flows/**/*.test.ts'],
    // Invarianterna körs i ett eget varv efter flödena (package.json), eftersom Vitest
    // annars sorterar filerna efter storlek och inte efter namn.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
