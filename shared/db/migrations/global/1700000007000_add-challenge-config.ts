/**
 * Botskyddets inställningar (docs/plan.md 8.5) i `config`, så att tröskelvärden och kill switchen kan ändras
 * utan deploy. Additiv (nya nycklar). Koden faller tillbaka på samma standardvärden om en nyckel saknas, så
 * ett försenat migrationsjobb aldrig stoppar `queue/join`.
 *
 * - challenge_enabled: kill switch (1 = på, 0 = av: ingen utmaning, som före Fas 8)
 * - challenge_ip_attempts_per_minute: signal 1, joinförsök per IP och minut (varje försök räknas, även med bevis)
 * - challenge_ip_joins_per_window: signal 2, reserverade joins per IP och event under 10 min
 *   (signal 1 och 2 räknas som EN signal vid nivåbeslutet, så ett delat nät ensamt ger högst nivå 1)
 * - challenge_global_queue_depth: signal 3, ködjup som utmanar alla nya besökare (0 = av)
 * - challenge_pow_bits: proof-of-work-svårighet (inledande nollbitar i SHA-256)
 */
import type { MigrationBuilder } from 'node-pg-migrate';

const KEYS = [
  ['challenge_enabled', '1'],
  ['challenge_ip_attempts_per_minute', '30'],
  ['challenge_ip_joins_per_window', '10'],
  ['challenge_global_queue_depth', '0'],
  ['challenge_pow_bits', '16'],
] as const;

export function up(pgm: MigrationBuilder): void {
  for (const [key, value] of KEYS) {
    pgm.sql(
      `INSERT INTO config (key, value) VALUES ('${key}', '${value}') ON CONFLICT (key) DO NOTHING;`,
    );
  }
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`DELETE FROM config WHERE key IN (${KEYS.map(([key]) => `'${key}'`).join(', ')});`);
}
