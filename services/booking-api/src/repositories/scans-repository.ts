/**
 * All SQL för biljettskanning (docs/plan.md 7.13 E7). `tickets.qr_token` slås upp per event
 * (indexet `(event_id, qr_token)`); den unika raden i `ticket_scans (event_id, ticket_id)` är
 * det som gör två samtidiga skanningar av samma biljett till exakt en `ok`.
 */
import type { PoolClient } from 'pg';
import type { ScannableTicketRow, TicketScanRow } from '../types/scan.js';

export async function findTicketByQrToken(
  client: PoolClient,
  eventId: string,
  qrToken: string,
): Promise<ScannableTicketRow | undefined> {
  const { rows } = await client.query<{
    id: string;
    status: ScannableTicketRow['status'];
    section_id: string;
    row: string;
    number: number;
  }>(
    `SELECT t.id, t.status, s.section_id, s.row, s.number
     FROM tickets t
     JOIN seats s ON s.id = t.seat_id AND s.event_id = t.event_id
     WHERE t.event_id = $1 AND t.qr_token = $2
     FOR SHARE OF t`,
    [eventId, qrToken],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        status: row.status,
        sectionId: row.section_id,
        row: row.row,
        number: row.number,
      };
}

/** Returnerar `true` om raden skapades, `false` om biljetten redan var skannad. */
export async function insertScan(
  client: PoolClient,
  params: { eventId: string; ticketId: string; gate: string; scannedBy: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO ticket_scans (event_id, ticket_id, gate, scanned_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id, ticket_id) DO NOTHING`,
    [params.eventId, params.ticketId, params.gate, params.scannedBy],
  );
  return rowCount === 1;
}

export async function getExistingScan(
  client: PoolClient,
  eventId: string,
  ticketId: string,
): Promise<TicketScanRow | undefined> {
  const { rows } = await client.query<{ scanned_at: Date; gate: string }>(
    'SELECT scanned_at, gate FROM ticket_scans WHERE event_id = $1 AND ticket_id = $2',
    [eventId, ticketId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { scannedAt: row.scanned_at, gate: row.gate };
}
