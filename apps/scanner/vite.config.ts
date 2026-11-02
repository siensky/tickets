/**
 * Vite-config för biljettscannern (docs/plan.md 7.8): en vanlig webbapp på scan.<domän>, ingen
 * PWA och ingen offline. Port 5174 lokalt (Auth0-callbacken `http://localhost:5174`).
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: { port: 5174 },
});
