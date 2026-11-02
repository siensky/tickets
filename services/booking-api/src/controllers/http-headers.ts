/**
 * Shared header-reading helper (docs/rules.md §1: controllers format
 * in/out, no business logic). Fastify gives a repeated header as a
 * string[] — every call site here wants exactly one value.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function readRequiredHeader(
  request: FastifyRequest,
  headerName: string,
  onMissing: () => never,
): string {
  const header = request.headers[headerName];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.length === 0) {
    onMissing();
  }
  return value;
}

/**
 * Headers för publika, anonyma GET-svar som får cachas vid Cloudflares kant (docs/plan.md 8.3). Svaret är samma
 * för alla och API:t använder aldrig cookies, så `Access-Control-Allow-Origin: *` är säkert. Utan det beror
 * CORS-headern på anroparens Origin, och ett cachat svar till en anropare utan Origin (curl, crawler) skulle
 * annars serveras utan header till webbappen. Cloudflare följer inte Vary: Origin.
 */
export function setPublicCacheHeaders(reply: FastifyReply, cacheControl: string): void {
  reply.header('cache-control', cacheControl).header('access-control-allow-origin', '*');
}
