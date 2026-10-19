/**
 * Vite config for the customer PWA (docs/plan.md "Klienter" — installable
 * on web, mobile, and desktop from one codebase). Service worker / PWA
 * manifest wiring (vite-plugin-pwa) is added in Fas 5 alongside offline
 * ticket support.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
