/**
 * Fångar webbläsarens anrop till PostHog i e2e (docs/plan.md 7.15). e2e-bygget av webbappen får
 * `VITE_POSTHOG_KEY=phc_e2e_dummy` och `VITE_POSTHOG_HOST=<appens origin>/ingest`; Playwright
 * svarar själv på `**\/ingest/**`, sparar händelserna för assertion och låter flaggorna svara
 * med fasta värden. Ingen trafik når PostHog.
 */
import type { Page, Route } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

export const POSTHOG_E2E_KEY = 'phc_e2e_dummy';
const SEATS_LEFT_FLAG = 'show_seats_left_badge';

export interface CapturedEvents {
  names(): string[];
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
): Promise<void> {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const body = request.postDataBuffer();
  if (body !== null) {
    captured.push(...eventsIn(decodeBody(body)));
  }
  if (pathname.endsWith('/config.js')) {
    // Fjärrkonfigurationen laddas som ett script som fyller window._POSTHOG_REMOTE_CONFIG.
    await route.fulfill({
      contentType: 'application/javascript',
      body: `(window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {})['${POSTHOG_E2E_KEY}'] = { config: { token: '${POSTHOG_E2E_KEY}', hasFeatureFlags: true, supportedCompression: ['gzip', 'gzip-js'] }, siteApps: [] };`,
    });
  } else if (pathname.includes('/flags') || pathname.includes('/decide')) {
    await route.fulfill({ json: flagsResponse() });
  } else if (pathname.includes('/static/')) {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
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
  await page.route('**/ingest/**', (route) => fulfillIngest(route, captured));
  return {
    names: () => captured.map((event) => String(event['event'])),
    find: (name) => captured.find((event) => event['event'] === name),
  };
}
