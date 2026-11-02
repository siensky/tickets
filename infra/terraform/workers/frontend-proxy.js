/**
 * Serverar PWA:n (apps/web) på apex-domänen, med SPA-fallback till
 * index.html — se infra/terraform/cloudflare-frontend.tf:s header-
 * kommentar för varför det här måste vara en Worker och inte en vanlig
 * R2 "Custom Domain": bucketen delas med de nattliga databas-backuperna
 * (docs/adr/0005-backup-storage-r2.md), och en Custom Domain gör HELA
 * bucketen publik på domänen, inte bara "frontend/"-prefixet. Workern
 * läser objekt via sin egen R2-binding (FRONTEND_BUCKET), vilket aldrig
 * kräver att bucketen görs publik — backuperna förblir onåbara via
 * tikknet.se oavsett vad någon begär.
 *
 * Samma script körs för både apex (PREFIX=frontend) och scan.<domän> (PREFIX=scanner,
 * docs/plan.md 7.8) — se cloudflare-frontend.tf. Med bindingen POSTHOG_PROXY=true
 * (bara apex) vidarebefordras också /ingest/* till PostHogs EU-moln (docs/plan.md 7.7):
 * utan en proxy på egen domän blockerar adblockers en stor andel av händelserna.
 * Inga andra sökvägar skickas någonsin vidare.
 */

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

function guessContentType(key) {
  const dot = key.lastIndexOf('.');
  if (dot === -1) {
    return 'application/octet-stream';
  }
  const extension = key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Vite lägger alltid sina hashade, evigt cachebara filer under /assets/. */
function cacheControlFor(key, prefix) {
  return key.startsWith(`${prefix}/assets/`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

function hasFileExtension(pathname) {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

const INGEST_PATH = '/ingest';
const POSTHOG_ASSETS_HOST = 'eu-assets.i.posthog.com';
const POSTHOG_API_HOST = 'eu.i.posthog.com';
const INGEST_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

function isIngestPath(pathname) {
  return pathname === INGEST_PATH || pathname.startsWith(`${INGEST_PATH}/`);
}

async function proxyToPostHog(request, url) {
  if (!INGEST_METHODS.has(request.method)) {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const upstreamHost = url.pathname.startsWith(`${INGEST_PATH}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_API_HOST;
  const upstream = new URL(`https://${upstreamHost}`);
  upstream.pathname = url.pathname.slice(INGEST_PATH.length) || '/';
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  headers.set('host', upstreamHost);
  headers.delete('cookie');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp !== null) {
    headers.set('x-forwarded-for', clientIp);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return fetch(upstream, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (env.POSTHOG_PROXY === 'true' && isIngestPath(requestUrl.pathname)) {
      return proxyToPostHog(request, requestUrl);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { pathname } = requestUrl;
    const prefix = env.PREFIX ?? 'frontend';
    const requestedKey = `${prefix}${pathname === '/' ? '/index.html' : pathname}`;

    let object = await env.FRONTEND_BUCKET.get(requestedKey);
    let key = requestedKey;

    // Klientsidig routing (/events/:id, /my-tickets, …) har ingen
    // motsvarande fil i bucketen — serva index.html, samma princip som
    // Cloudflare Pages' egen SPA-fallback (R2 Custom Domains saknar
    // detta inbyggt, därför Workern).
    if (object === null && !hasFileExtension(pathname)) {
      key = `${prefix}/index.html`;
      object = await env.FRONTEND_BUCKET.get(key);
    }

    if (object === null) {
      return new Response('Not Found', { status: 404 });
    }

    // writeHttpMetadata() först som bas (rclone kan ha satt egna
    // metadata-fält) — content-type och cache-control sätts sedan
    // ALLTID om explicit, så vår egen policy (hashade assets cachas i
    // ett år, allt annat cachas inte alls) vinner oavsett vad rclone
    // råkade skriva vid uppladdningen.
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('content-type', object.httpMetadata?.contentType ?? guessContentType(key));
    headers.set('cache-control', cacheControlFor(key, prefix));
    headers.set('etag', object.httpEtag);

    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
