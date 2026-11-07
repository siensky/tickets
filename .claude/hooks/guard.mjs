/**
 * Ingången för PreToolUse-spärren (ADR-0012, rules.md §12). Logiken ligger i guard-core.mjs, som läses in
 * här i ett try/catch.
 *
 * Fallgrop: en statisk import som misslyckas (syntaxfel, saknad fil) avslutar node med exit 1 innan någon
 * kod körs, och exit 1 blockerar inte kommandot i Claude Code; bara exit 2 gör det. Därför är den här
 * filen medvetet liten och importerar inget statiskt: varje fel, även ett i läsningen av reglerna,
 * blir exit 2 med orsaken på stderr (fail closed).
 */
import { readFileSync } from 'node:fs';

try {
  const { runHook } = await import('./guard-core.mjs');
  const output = runHook(readFileSync(0, 'utf8'));
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(
    `[guard:crash] Spärren kunde inte köras och blockerar kommandot: ${error}\n`,
  );
  process.exitCode = 2;
}
