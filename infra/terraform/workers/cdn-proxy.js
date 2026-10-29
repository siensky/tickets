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
 * tikknet-logo.svg) är inte versionerade, så en ändrad bild skulle annars aldrig nå ut.
 */

const ALLOWED_PREFIXES = ['images/', 'brand/'];
const CACHE_CONTROL = 'public, max-age=86400';

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

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const key = toAllowedKey(new URL(request.url).pathname);
    const object = key === null ? null : await env.CDN_BUCKET.get(key);
    if (object === null) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers(corsHeadersFor(request, env));
    object.writeHttpMetadata(headers);
    headers.set('content-type', object.httpMetadata?.contentType ?? guessContentType(key));
    headers.set('cache-control', CACHE_CONTROL);
    headers.set('etag', object.httpEtag);

    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
