/** Enhetstester för scannern: jsdom och den delade testuppsättningen. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
