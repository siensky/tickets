/**
 * Vite config for the customer PWA (docs/plan.md "Klienter" — installable
 * on web, mobile, and desktop from one codebase). docs/plan.md "Offline":
 * app shell + "mina biljetter med QR-koder" work offline; booking does
 * not and must show that clearly — the runtime caching below only
 * covers the app shell and `/me/tickets`, nothing under `/events`.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: {
        name: 'Tickets',
        short_name: 'Tickets',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1565c0',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        runtimeCaching: [
          {
            // "mina biljetter" — the one booking-api response that must
            // still be readable offline (docs/plan.md "Offline").
            urlPattern: ({ url }) => url.pathname === '/me/tickets',
            handler: 'NetworkFirst',
            options: { cacheName: 'my-tickets', networkTimeoutSeconds: 3 },
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
});
