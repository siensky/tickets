/**
 * Väntrummets config-nycklar (docs/plan.md "Väntrum": "Insläppstakt
 * ... + sessionstid ... Båda i config-tabellen, ändringsbara live").
 * Framåtkompatibel tillägg per docs/rules.md §4 — körs innan Fas 3:s
 * kod som läser dem deployas.
 *
 * Tre separata nycklar, inte en: insläppstakten styr scheduler-workers
 * insläppsjobb, medan de två sessionstalen styr kötokens `exp`
 * (hårt tak, shared/auth) respektive `admitted:*`-nyckelns TTL
 * (inaktivitetstak, shared/redis) — olika konsumenter, olika värden,
 * ingen anledning att slå ihop dem till en sträng att parsa isär.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    INSERT INTO config (key, value) VALUES
      ('queue_admission_rate_per_minute', '300'),
      ('queue_session_total_minutes', '15'),
      ('queue_session_inactivity_minutes', '10');
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DELETE FROM config WHERE key IN (
      'queue_admission_rate_per_minute',
      'queue_session_total_minutes',
      'queue_session_inactivity_minutes'
    );
  `);
}
