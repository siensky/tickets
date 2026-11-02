/**
 * Fångar webbläsarens anrop till PostHog i e2e (docs/plan.md 7.15). e2e-bygget av webbappen får
 * `VITE_POSTHOG_KEY=phc_e2e_dummy` och `VITE_POSTHOG_HOST=<appens origin>/ingest`; Playwright
 * svarar själv på `**\/ingest/**`, sparar händelserna för assertion och låter flaggorna svara
 * med fasta värden. Ingen trafik når PostHog.
 */
import type { Page, Route } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// posthog-js hämtar sina tillägg (t.ex. inspelaren) som /ingest/static/<namn>.js; de serveras här ur webbappens
// installerade paket så att ingen trafik når PostHog.
const POSTHOG_DIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/web/node_modules/posthog-js/dist',
);

function staticScript(pathname: string): string {
  const file = join(POSTHOG_DIST, pathname.slice(pathname.lastIndexOf('/') + 1));
  return file.startsWith(POSTHOG_DIST) && existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export const POSTHOG_E2E_KEY = 'phc_e2e_dummy';
const SEATS_LEFT_FLAG = 'show_seats_left_badge';

export interface CapturedEvents {
  names(): string[];
  /** Antal anrop till PostHogs inspelningsändpunkt (`/s/`): session replay (docs/plan.md 8.4). */
  recordingRequests(): number;
  find(name: string): Record<string, unknown> | undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** PostHog skickar JSON, gzip eller `data=<base64>` beroende på webbläsare och version. */
function decodeBody(buffer: Buffer): unknown {
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const text = (isGzip ? gunzipSync(buffer) : buffer).toString('utf8');
  if (text.startsWith('data=')) {
    const encoded = decodeURIComponent(text.slice('data='.length));
    return parseJson(Buffer.from(encoded, 'base64').toString('utf8'));
  }
  return parseJson(text);
}

function eventsIn(payload: unknown): Record<string, unknown>[] {
  // Batchade anrop är `{ api_key, batch: [...] }`; enstaka händelser är ett objekt eller en lista.
  const batch =
    typeof payload === 'object' && payload !== null && 'batch' in payload
      ? payload.batch
      : payload;
  const items = Array.isArray(batch) ? batch : [batch];
  return items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && 'event' in item,
  );
}

function flagsResponse(): unknown {
  return {
    featureFlags: { [SEATS_LEFT_FLAG]: true },
    featureFlagPayloads: {},
    flags: {
      [SEATS_LEFT_FLAG]: {
        key: SEATS_LEFT_FLAG,
        enabled: true,
        variant: null,
        reason: { code: 'e2e', description: 'e2e', condition_index: 0 },
        metadata: { id: 1, version: 1, payload: null, description: null },
      },
    },
    config: { enable_collect_everything: false },
    errorsWhileComputingFlags: false,
    quotaLimited: [],
    supportedCompression: ['gzip', 'gzip-js'],
  };
}

async function fulfillIngest(
  route: Route,
  captured: Record<string, unknown>[],
  recordings: { count: number },
): Promise<void> {
  const request = route.request();
  const { pathname } = new URL(request.url());
  if (/\/s\/?$/.test(pathname)) {
    recordings.count += 1;
  }
  const body = request.postDataBuffer();
  if (body !== null) {
    captured.push(...eventsIn(decodeBody(body)));
  }
  if (pathname.endsWith('/config.js')) {
    // Fjärrkonfigurationen laddas som ett script som fyller window._POSTHOG_REMOTE_CONFIG.
    await route.fulfill({
      contentType: 'application/javascript',
      body: `(window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {})['${POSTHOG_E2E_KEY}'] = { config: { token: '${POSTHOG_E2E_KEY}', hasFeatureFlags: true, supportedCompression: ['gzip', 'gzip-js'], sessionRecording: { endpoint: '/s/' } }, siteApps: [] };`,
    });
  } else if (pathname.includes('/flags') || pathname.includes('/decide')) {
    await route.fulfill({ json: flagsResponse() });
  } else if (pathname.includes('/static/')) {
    await route.fulfill({
      contentType: 'application/javascript',
      body: staticScript(pathname),
    });
  } else {
    await route.fulfill({ json: { status: 1 } });
  }
}

export async function capturePostHog(page: Page): Promise<CapturedEvents> {
  // PostHog behandlar webbläsare som botar (och skickar då ingenting) om navigator.webdriver är
  // satt eller userAgentData-märkena innehåller "HeadlessChrome". User-agenten sätts i
  // playwright.config.ts av samma skäl.
  await page.addInitScript(`
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  `);
  const captured: Record<string, unknown>[] = [];
  const recordings = { count: 0 };
  await page.route('**/ingest/**', (route) => fulfillIngest(route, captured, recordings));
  return {
    names: () => captured.map((event) => String(event['event'])),
    recordingRequests: () => recordings.count,
    find: (name) => captured.find((event) => event['event'] === name),
  };
}
