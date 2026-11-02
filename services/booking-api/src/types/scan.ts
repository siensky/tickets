/** Resultatet av en skanning (docs/plan.md 7.13 E7). En nekad biljett är ett affärsutfall, inte ett fel. */
export type ScanOutcome =
  | {
      readonly result: 'ok';
      readonly sectionName: string;
      readonly row: string;
      readonly number: number;
    }
  | { readonly result: 'already_scanned'; readonly scannedAt: string; readonly gate: string }
  | { readonly result: 'not_found' }
  | { readonly result: 'refunded' }
  | { readonly result: 'void' };

export interface ScannableTicketRow {
  readonly id: string;
  readonly status: 'valid' | 'refunded' | 'void';
  readonly sectionId: string;
  readonly row: string;
  readonly number: number;
}

export interface TicketScanRow {
  readonly scannedAt: Date;
  readonly gate: string;
}
