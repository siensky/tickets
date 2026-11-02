/**
 * Tester för cdn-proxy.js (docs/plan.md 7.19). Vitelistan är en säkerhetsgräns:
 * bucketen innehåller även databasbackuperna, så varje icke-vitlistad sökväg måste ge 404.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './cdn-proxy.js';

const OBJECTS = {
  'brand/tikknet-icon.svg': '<svg/>',
  'images/rock-night.webp': 'webp-bytes',
  'backups/shard-0-2026-10-29.dump': 'SECRET-BACKUP',
  'frontend/index.html': '<html/>',
};

/** Nycklar som bucketen faktiskt slogs upp med — gränsen ska hållas INNAN bucketen frågas. */
const requestedKeys = [];

function fakeEnv() {
  return {
    ALLOWED_ORIGINS: 'https://tikknet.se,https://scan.tikknet.se',
    CDN_BUCKET: {
      async get(key, options) {
        requestedKeys.push(key);
        const body = OBJECTS[key];
        if (body === undefined) {
          return null;
        }
        const object = { httpEtag: '"etag"', httpMetadata: undefined, writeHttpMetadata() {} };
        // R2 med `onlyIf`: uppfyllt If-None-Match ger ett objekt UTAN body.
        if (options?.onlyIf?.get('if-none-match') === '"etag"') {
          return object;
        }
        return { ...object, body };
      },
    },
  };
}

/** Minimal Cache API-ersättning: nyckel = URL, lagrar en klon av svaret. */
function stubCache() {
  const store = new Map();
  vi.stubGlobal('caches', {
    default: {
      async match(key) {
        return store.get(key.url)?.clone();
      },
      async put(key, response) {
        store.set(key.url, response);
      },
    },
  });
}

const pending = [];
const ctx = { waitUntil: (promise) => pending.push(promise) };

async function request(path, init) {
  const response = await worker.fetch(
    new Request(`https://cdn.tikknet.se${path}`, init),
    fakeEnv(),
    ctx,
  );
  await Promise.all(pending.splice(0));
  return response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubCache();
});

describe('cdn-proxy', () => {
  it('serverar en vitlistad fil med cache-header och rätt content-type', async () => {
    const response = await request('/brand/tikknet-icon.svg');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<svg/>');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('serverar filer under images/', async () => {
    const response = await request('/images/rock-night.webp');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it.each([
    ['/backups/shard-0-2026-10-29.dump'],
    ['/frontend/index.html'],
    ['/'],
    ['/brand/../backups/shard-0-2026-10-29.dump'],
    ['/brand/%2e%2e/backups/shard-0-2026-10-29.dump'],
    ['/brand%2f..%2fbackups/shard-0-2026-10-29.dump'],
    ['/images/%2e%2e/frontend/index.html'],
    ['/brand/%zz'],
    ['/BRAND/tikknet-icon.svg'],
    ['/brandx/tikknet-icon.svg'],
    ['/images-foo/rock-night.webp'],
    ['//backups/shard-0-2026-10-29.dump'],
    ['/brand%2F..%2F..%2Fbackups/shard-0-2026-10-29.dump'],
    ['/brand/%00'],
    ['/brand%5c..%5cbackups/x'],
  ])('ger 404 för %s', async (path) => {
    requestedKeys.length = 0;

    const response = await request(path);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SECRET-BACKUP');
  });

  it('frågar aldrig bucketen med en nyckel utanför images/ och brand/', async () => {
    requestedKeys.length = 0;

    await request('/brand%2F..%2F..%2Fbackups/x');
    await request('/backups/shard-0-2026-10-29.dump');
    await request('/brand/../backups/x');

    expect(requestedKeys).toEqual([]);
  });

  it('ger 404 för en vitlistad sökväg som saknas', async () => {
    expect((await request('/brand/finns-inte.svg')).status).toBe(404);
  });

  it('avvisar andra metoder än GET och HEAD', async () => {
    expect((await request('/brand/tikknet-icon.svg', { method: 'POST' })).status).toBe(405);
  });

  it('svarar på HEAD utan body', async () => {
    const response = await request('/brand/tikknet-icon.svg', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it.each([['https://tikknet.se'], ['https://scan.tikknet.se']])(
    'tillåter CORS från %s',
    async (origin) => {
      const response = await request('/brand/tikknet-icon.svg', { headers: { origin } });

      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('vary')).toBe('Origin');
    },
  );

  it('ger ingen CORS-header till en okänd origin', async () => {
    const response = await request('/brand/tikknet-icon.svg', {
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sätter Vary: Origin även utan Origin-header', async () => {
    const response = await request('/brand/tikknet-icon.svg');

    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('svarar 304 när If-None-Match matchar ETag', async () => {
    const response = await request('/images/rock-night.webp', {
      headers: { 'if-none-match': '"etag"' },
    });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"etag"');
  });

  it('svarar 200 med hela filen när ETag har ändrats', async () => {
    const response = await request('/images/rock-night.webp', {
      headers: { 'if-none-match': '"gammal"' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('webp-bytes');
  });

  it('serverar andra anropet från kantcachen utan att fråga bucketen, och ger 304 därifrån', async () => {
    await request('/images/rock-night.webp');
    requestedKeys.length = 0;

    const second = await request('/images/rock-night.webp');
    const conditional = await request('/images/rock-night.webp', {
      headers: { 'if-none-match': '"etag"' },
    });

    expect(second.status).toBe(200);
    expect(await second.text()).toBe('webp-bytes');
    expect(conditional.status).toBe(304);
    expect(requestedKeys).toEqual([]);
  });

  it('cachar aldrig ett 404', async () => {
    await request('/brand/finns-inte.svg');
    requestedKeys.length = 0;

    await request('/brand/finns-inte.svg');

    expect(requestedKeys).toEqual(['brand/finns-inte.svg']);
  });

  it('håller CORS-headern rätt per origin även med kantcache', async () => {
    const apex = await request('/brand/tikknet-icon.svg', {
      headers: { origin: 'https://tikknet.se' },
    });
    const scanner = await request('/brand/tikknet-icon.svg', {
      headers: { origin: 'https://scan.tikknet.se' },
    });
    const scannerAgain = await request('/brand/tikknet-icon.svg', {
      headers: { origin: 'https://scan.tikknet.se' },
    });

    expect(apex.headers.get('access-control-allow-origin')).toBe('https://tikknet.se');
    expect(scanner.headers.get('access-control-allow-origin')).toBe('https://scan.tikknet.se');
    expect(scannerAgain.headers.get('access-control-allow-origin')).toBe(
      'https://scan.tikknet.se',
    );
  });
});
