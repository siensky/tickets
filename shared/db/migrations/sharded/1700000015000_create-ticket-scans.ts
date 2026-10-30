/**
 * `ticket_scans` (docs/plan.md 7.13 E7): en rad per skannad biljett. Det
 * unika indexet på `(event_id, ticket_id)` är det som gör två samtidiga
 * skanningar av samma biljett till exakt en `ok` (INSERT ... ON CONFLICT
 * DO NOTHING). Ingen FK på `ticket_id`, samma mjuka referens som övriga
 * shardade tabeller.
 *
 * Indexet på `tickets (event_id, qr_token)` bär uppslaget från QR-koden,
 * som bara innehåller `qr_token` (en HMAC som inte går att avkoda).
 *
 * Byggs i Fas 7 steg 5 (migrationerna), medan endpointen POST /scans hör
 * till steg 9. Tabellen är oanvänd tills dess.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('ticket_scans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    event_id: { type: 'uuid', notNull: true },
    ticket_id: { type: 'uuid', notNull: true },
    gate: { type: 'text', notNull: true },
    scanned_by: { type: 'text', notNull: true },
    scanned_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('ticket_scans', ['event_id', 'ticket_id'], { unique: true });
  pgm.createIndex('tickets', ['event_id', 'qr_token']);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex('tickets', ['event_id', 'qr_token']);
  pgm.dropTable('ticket_scans');
}
