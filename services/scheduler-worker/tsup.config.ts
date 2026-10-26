import { defineConfig } from 'tsup';
import { createServiceTsupConfig } from '../../tsup.base.js';

export default defineConfig(
  createServiceTsupConfig([
    'src/scripts/reset-sale.ts',
    'src/scripts/generate-sale-report.ts',
    'src/scripts/seed-demo-events.ts',
  ]),
);
