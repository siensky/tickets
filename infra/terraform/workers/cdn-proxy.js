/**
 * Serverar statiska filer (eventbilder, varumärkesfiler) på cdn.<domän> — se
 * infra/terraform/cloudflare-frontend.tf och docs/plan.md 7.19.
 *
 * Bucketen delas med de nattliga databas-backuperna (docs/adr/0005-backup-storage-r2.md),
 * så detta är en säkerhetsgräns: BARA nycklar under ALLOWED_PREFIXES läses, allt
 * annat (backups/, frontend/, sökvägar med ".." — även URL-kodade) ger 404. Lägg
 * aldrig till ett prefix här utan att tänka på vad som annars ligger under det.
 *
 * Fallgrop: cache-control är medvetet INTE immutable — filnamnen (<slug>.webp,
 * tikknet-logo.svg) är inte versionerade, så en ändrad bild skulle annars aldrig nå ut. Därför
 * kort TTL för brand/ (filer som byts med oförändrat namn) och längre för images/ (docs/plan.md 8.3).
 *
 * Kantcache (Cache API) och 304 (docs/plan.md 8.3): bara svar 200 cachas, aldrig 404/fel. Cache-nyckeln
 * innehåller origin, eftersom CORS-headern i svaret beror på den och Cache API inte följer Vary.
 * `If-None-Match` ger 304, både från kantcachen och från R2 (`onlyIf`).
 */

const ALLOWED_PREFIXES = ['images/', 'brand/'];
const CACHE_CONTROL_BY_PREFIX = {
  'brand/': 'public, max-age=300',
  'images/': 'public, max-age=86400',
};

const CONTENT_TYPES = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function guessContentType(key) {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Returnerar bucket-nyckeln, eller null om sökvägen inte får läsas. */
function toAllowedKey(pathname) {
  let key;
  try {
    key = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  const hasDotSegment = key.split('/').some((segment) => segment === '.' || segment === '..');
  if (hasDotSegment || !ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return null;
  }
  return key;
}

/**
 * Vary: Origin sätts ALLTID (även utan CORS-header), annars kan webbläsaren återanvända
 * ett svar från en vanlig <img>-begäran för en senare CORS-begäran och avvisa det.
 */
function corsHeadersFor(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',');
  if (origin === null || !allowed.includes(origin)) {
    return { vary: 'Origin' };
  }
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function cacheControlFor(key) {
  const prefix = ALLOWED_PREFIXES.find((candidate) => key.startsWith(candidate));
  return CACHE_CONTROL_BY_PREFIX[prefix];
}

/**
 * Cache-nyckel: den egna URL:en plus den TILLÅTNA origin (tom för okänd eller saknad), samma värde som
 * `corsHeadersFor` ger CORS-header för. Normaliseringen hindrar att godtyckliga Origin-värden skapar egna poster.
 */
function cacheKeyFor(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',');
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('o', origin !== null && allowed.includes(origin) ? origin : '');
  return new Request(url);
}

/** Bara förhandsvillkoren för GET (If-None-Match, If-Modified-Since): If-Match skulle ge 304 där 412 vore rätt. */
function conditionalHeaders(request) {
  const headers = new Headers();
  for (const name of ['if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
}

function notModified(headers) {
  return new Response(null, { status: 304, headers });
}

function matchesEtag(request, etag) {
  const header = request.headers.get('if-none-match');
  return (
    header !== null && etag !== null && header.split(',').some((tag) => tag.trim() === etag)
  );
}

function buildHeaders(request, env, key, object) {
  const headers = new Headers(corsHeadersFor(request, env));
  object.writeHttpMetadata(headers);
  headers.set('content-type', object.httpMetadata?.contentType ?? guessContentType(key));
  headers.set('cache-control', cacheControlFor(key));
  headers.set('etag', object.httpEtag);
  return headers;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { pathname } = new URL(request.url);
    const key = toAllowedKey(pathname);
    if (key === null) {
      return new Response('Not Found', { status: 404 });
    }

    const cache = typeof caches === 'undefined' ? undefined : caches.default;
    const cacheKey = cacheKeyFor(request, env);
    const cached = cache === undefined ? undefined : await cache.match(cacheKey);
    if (cached !== undefined) {
      const hit = new Response(request.method === 'HEAD' ? null : cached.body, cached);
      return matchesEtag(request, hit.headers.get('etag')) ? notModified(hit.headers) : hit;
    }

    const object = await env.CDN_BUCKET.get(key, { onlyIf: conditionalHeaders(request) });
    if (object === null) {
      return new Response('Not Found', { status: 404 });
    }
    const headers = buildHeaders(request, env, key, object);
    // Utan `body` var förhandsvillkoret (If-None-Match) uppfyllt: filen är oförändrad.
    if (!('body' in object)) {
      return notModified(headers);
    }

    const response = new Response(request.method === 'HEAD' ? null : object.body, { headers });
    if (cache !== undefined && request.method === 'GET') {
      ctx?.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
