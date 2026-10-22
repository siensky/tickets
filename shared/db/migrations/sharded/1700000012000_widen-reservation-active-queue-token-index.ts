/**
 * Widens `reservations_active_queue_token_unique` to also cover
 * `pending_payment` (docs/plan.md "Betalning": "en aktiv Checkout per
 * kötoken ... annars blir frysningen ett sätt att hålla stolar gratis").
 *
 * The original index only covered `status = 'active'`
 * (1700000003000_create-reservations.ts), so once a reservation froze to
 * `pending_payment` its queue token was free to create and freeze a new
 * `active` reservation — an unlimited, free seat hold. Forward-compatible:
 * additive migration per docs/rules.md §4, old code (which never produces
 * two simultaneous `pending_payment` rows for the same token on its own)
 * keeps working unchanged against the wider index.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.dropIndex('reservations', 'queue_token_id', {
    name: 'reservations_active_queue_token_unique',
  });
  pgm.createIndex('reservations', 'queue_token_id', {
    unique: true,
    where: "status IN ('active', 'pending_payment')",
    name: 'reservations_active_queue_token_unique',
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropIndex('reservations', 'queue_token_id', {
    name: 'reservations_active_queue_token_unique',
  });
  pgm.createIndex('reservations', 'queue_token_id', {
    unique: true,
    where: "status = 'active'",
    name: 'reservations_active_queue_token_unique',
  });
}
