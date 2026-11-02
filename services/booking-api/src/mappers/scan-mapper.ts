/** Databasrader → svarsobjekt för `POST /scans` (docs/plan.md 7.13 E7). */
import type { ScannableTicketRow, ScanOutcome, TicketScanRow } from '../types/scan.js';

export function toOkOutcome(ticket: ScannableTicketRow, sectionName: string): ScanOutcome {
  return { result: 'ok', sectionName, row: ticket.row, number: ticket.number };
}

export function toAlreadyScannedOutcome(scan: TicketScanRow): ScanOutcome {
  return {
    result: 'already_scanned',
    scannedAt: scan.scannedAt.toISOString(),
    gate: scan.gate,
  };
}
