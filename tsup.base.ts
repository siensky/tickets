/**
 * Delad tsup-bas för alla fem tjänster — var tidigare en handhållen,
 * byte-identisk kopia i varje tjänsts egen tsup.config.ts. ESLint bevakar
 * inte *.config.ts-filer (globalt ignorerade), så en divergens mellan
 * kopiorna hade varit tyst tills ett bygge gick fel.
 *
 * EXTERNAL_NPM_PACKAGES måste hållas i synk för hand ändå — det är hela
 * uppsättningen riktiga npm-paket som förekommer någonstans i shared/*,
 * och tsup kan inte härleda den automatiskt (se motiveringen nedan) —
 * men nu finns bara EN lista att hålla i synk, inte fem.
 */
import type { Options } from 'tsup';

/**
 * @tickets/* workspace-paket bundlas in i dist/index.js (de är bara TS-
 * källkod, inte publicerade npm-paket) så Docker-imagen blir
 * självförsörjande för monorepo-koden. Riktiga npm-paket — även
 * transitiva sådana som pino/prom-client (via @tickets/observability) —
 * måste förbli externa: pino går sönder om den buntas in, eftersom dess
 * worker-thread-transport laddar filer via dynamiska require()-anrop som
 * en bundlad enfilsbuild inte kan lösa.
 *
 * tsup externaliserar bara DIREKTA dependencies i package.json som
 * standard — transitiva npm-paket (de som bara @tickets/observability
 * importerar) faller annars igenom till standardbeteendet och buntas in
 * av misstag. Listan nedan är hela uppsättningen riktiga npm-paket som
 * förekommer någonstans i shared/* — håll den i synk om ett nytt
 * tillkommer (ESLint fångar inte detta, bygget gör det med ett tydligt
 * runtime-fel om ett paket saknas här).
 */
export const EXTERNAL_NPM_PACKAGES = [
  'fastify',
  '@fastify/websocket',
  'ws',
  'pino',
  'prom-client',
  'pg',
  'ioredis',
  'amqplib',
  'zod',
  'posthog-node',
];

export function createServiceTsupConfig(): Options {
  return {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    noExternal: [/^@tickets\//],
    external: EXTERNAL_NPM_PACKAGES,
  };
}
