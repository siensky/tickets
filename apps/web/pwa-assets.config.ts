/**
 * Genererar PWA-ikonerna ur `public/brand/tikknet-icon.svg` (docs/plan.md 7.11): manifest och
 * iOS kräver PNG. Körs för hand (`pnpm generate-pwa-assets`) och resultatet committas.
 * Maskable-ikonen får 20 % säkerhetsmarginal på ink-färgad bakgrund.
 */
import { defineConfig } from '@vite-pwa/assets-generator/config';

const INK = '#161b24';

export default defineConfig({
  preset: {
    transparent: { sizes: [192, 512], favicons: [] },
    maskable: { sizes: [512], padding: 0.2, resizeOptions: { background: INK } },
    apple: { sizes: [180], resizeOptions: { background: INK } },
    assetName: (type, size) => {
      switch (type) {
        case 'transparent':
          return `pwa-${size.width}x${size.height}.png`;
        case 'maskable':
          return `maskable-${size.width}x${size.height}.png`;
        default:
          return `apple-touch-icon-${size.width}x${size.height}.png`;
      }
    },
  },
  images: ['public/brand/tikknet-icon.svg'],
});
