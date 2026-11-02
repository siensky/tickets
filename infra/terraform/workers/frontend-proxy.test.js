/**
 * Tester för frontend-proxy.js: /ingest-proxyn mot PostHog (docs/plan.md 7.7) och
 * prefixet som låter samma script serva scanner/ (7.8). Bucketen innehåller även
 * databasbackuperna, så inga andra sökvägar än prefixet får nås.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './frontend-proxy.js';

const OBJECTS = {
  'frontend/index.html': '<html>web</html>',
  'frontend/assets/app.js': 'js',
  'scanner/index.html': '<html>scanner</html>',
  'backups/shard-0.dump': 'SECRET-BACKUP',
};

function fakeEnv(extra = {}) {
  return {
    POSTHOG_PROXY: 'true',
    FRONTEND_BUCKET: {
      async get(key) {
        const body = OBJECTS[key];
        return body === undefined
          ? null
          : { body, httpEtag: '"e"', httpMetadata: undefined, writeHttpMetadata() {} };
      },
    },
    ...extra,
  };
}

function request(path, init, env = fakeEnv()) {
  return worker.fetch(new Request(`https://tikknet.se${path}`, init), env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('frontend-proxy /ingest', () => {
  it('skickar /ingest/static/* till eu-assets', async () => {
    const fetchMock = stubFetch();
    await request('/ingest/static/array.js?v=1');
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://eu-assets.i.posthog.com/static/array.js?v=1');
  });

  it('skickar övriga /ingest/* till eu.i.posthog.com, med body och utan cookies', async () => {
    const fetchMock = stubFetch();
    await request('/ingest/e/?ip=0', {
      method: 'POST',
      body: 'data=1',
      headers: { cookie: 'session=secret', 'cf-connecting-ip': '203.0.113.9' },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://eu.i.posthog.com/e/?ip=0');
    expect(init.method).toBe('POST');
    expect(init.headers.get('cookie')).toBeNull();
    expect(init.headers.get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('skickar aldrig vidare andra sökvägar än /ingest', async () => {
    const fetchMock = stubFetch();
    for (const path of ['/ingestion/x', '/ingest-evil', '/api/ingest', '/x/../ingestx']) {
      await request(path);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('vidarebefordrar inte /ingest när proxyn är av (scanner-domänen)', async () => {
    const fetchMock = stubFetch();
    const response = await request(
      '/ingest/e/',
      undefined,
      fakeEnv({ POSTHOG_PROXY: 'false' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200); // SPA-fallback, inte PostHog
  });

  it('nekar metoder som inte behövs', async () => {
    const fetchMock = stubFetch();
    const response = await request('/ingest/e/', { method: 'DELETE' });
    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('frontend-proxy prefix', () => {
  it('serverar frontend/ som standard med SPA-fallback', async () => {
    const response = await request('/events/abc');
    expect(await response.text()).toBe('<html>web</html>');
  });

  it('serverar scanner/ när PREFIX=scanner och når aldrig andra prefix', async () => {
    const env = fakeEnv({ PREFIX: 'scanner' });
    expect(await (await request('/', undefined, env)).text()).toBe('<html>scanner</html>');
    expect((await request('/backups/shard-0.dump', undefined, env)).status).toBe(404);
  });
});
