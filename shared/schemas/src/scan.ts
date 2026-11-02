/**
 * Body för `POST /scans` (docs/plan.md 7.13 E7). QR-koden innehåller bara `qr_token`, en
 * HMAC-SHA256 i hex (64 tecken, `services/booking-api/src/services/qr-token.ts`); `eventId`
 * väljer vilken shard och vilket event biljetten slås upp mot. `.strict()`: okända fält avvisas
 * (docs/rules.md §6).
 */
import { z } from 'zod';

export const MAX_GATE_LENGTH = 32;

export const scanBodySchema = z
  .object({
    eventId: z.string().uuid(),
    qrToken: z.string().regex(/^[0-9a-f]{64}$/),
    gate: z.string().trim().min(1).max(MAX_GATE_LENGTH),
  })
  .strict();

export type ScanBody = z.infer<typeof scanBodySchema>;

export const SCAN_RESULTS = [
  'ok',
  'already_scanned',
  'not_found',
  'refunded',
  'void',
] as const;
export type ScanResultKind = (typeof SCAN_RESULTS)[number];
