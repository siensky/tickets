/**
 * Direktinsläpp i väntrummet (docs/plan.md "Väntrum"): så många personer per event får vara
 * insläppta utan att ställas i kö. Därefter köar nya joinare som förut. 0 betyder att alla köar.
 * Framåtkompatibel tillägg per docs/rules.md §4 — körs innan koden som läser nyckeln deployas.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`INSERT INTO config (key, value) VALUES ('queue_direct_admit_limit', '1000');`);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`DELETE FROM config WHERE key = 'queue_direct_admit_limit';`);
}
