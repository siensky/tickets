/**
 * Vite config for the customer PWA (docs/plan.md "Klienter" — installable
 * on web, mobile, and desktop from one codebase). docs/plan.md "Offline":
 * app shell + "mina biljetter med QR-koder" work offline; booking does
 * not and must show that clearly — the runtime caching below only
 * covers the app shell and `/me/tickets`, nothing under `/events`.
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['brand/tikknet-logo.svg', 'brand/apple-touch-icon-180x180.png'],
      manifest: {
        name: 'tikknet',
        short_name: 'tikknet',
        lang: 'sv',
        start_url: '/',
        display: 'standalone',
        // Ink (#161b24) och base-100 i temat `tikknet` (docs/plan.md 7.11).
        background_color: '#f9fafb',
        theme_color: '#161b24',
        // PNG genereras ur brand/tikknet-icon.svg med `pnpm generate-pwa-assets`.
        icons: [
          { src: '/brand/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/brand/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/brand/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
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
