/**
 * Shared header-reading helper (docs/rules.md §1: controllers format
 * in/out, no business logic). Fastify gives a repeated header as a
 * string[] — every call site here wants exactly one value.
 */
import type { FastifyRequest } from 'fastify';

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
