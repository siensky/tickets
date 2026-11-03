/**
 * Bokningsfönstret i väntrummet (docs/plan.md "Väntrum"): hur många minuter en insläppt köare har på sig
 * att boka, räknat från INSLÄPPET och inte från JOIN. Utan det äter en lång kötid upp hela sessionen,
 * eftersom kötokenens `exp` räknas från join. Framåtkompatibel tillägg per docs/rules.md §4: koden som
 * läser nyckeln har ett standardvärde, så ett försenat migrationsjobb stoppar aldrig `queue/join`.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`INSERT INTO config (key, value) VALUES ('queue_booking_window_minutes', '10');`);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`DELETE FROM config WHERE key = 'queue_booking_window_minutes';`);
}
