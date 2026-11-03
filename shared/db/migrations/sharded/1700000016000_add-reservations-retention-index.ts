/**
 * Stödjande index för reservations-retentionen (scheduler-worker): jobbet väljer de äldsta avslutade
 * reservationerna efter `created_at`, och utan index blir varje batch en seq scan plus sortering av hela
 * tabellen. Partiellt på de statusar jobbet rör, så indexet inte växer med aktiva reservationer.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.createIndex('reservations', 'created_at', {
    name: 'reservations_retention_idx',
    where: "status IN ('converted', 'expired', 'cancelled')",
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex('reservations', 'created_at', { name: 'reservations_retention_idx' });
}
