/**
 * Tester för cdn-proxy.js (docs/plan.md 7.19). Vitelistan är en säkerhetsgräns:
 * bucketen innehåller även databasbackuperna, så varje icke-vitlistad sökväg måste ge 404.
 */
import { describe, expect, it } from 'vitest';
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
      async get(key) {
        requestedKeys.push(key);
        const body = OBJECTS[key];
        if (body === undefined) {
          return null;
        }
        return {
          body,
          httpEtag: '"etag"',
          httpMetadata: undefined,
          writeHttpMetadata() {},
        };
      },
    },
  };
}

function request(path, init) {
  return worker.fetch(new Request(`https://cdn.tikknet.se${path}`, init), fakeEnv());
}

describe('cdn-proxy', () => {
  it('serverar en vitlistad fil med cache-header och rätt content-type', async () => {
    const response = await request('/brand/tikknet-icon.svg');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<svg/>');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('serverar filer under images/', async () => {
    const response = await request('/images/rock-night.webp');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
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
});
