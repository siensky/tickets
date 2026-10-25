#!/usr/bin/env node
/**
 * Regressionstest för eslint-plugin-boundaries (rules.md §1: lagergränser
 * controllers -> services -> repositories). Skriver en avsiktlig, förbjuden
 * import (controllers importerar direkt från repositories/) till en
 * tillfällig fil i en riktig service, lintar den med riktiga ESLint-API:et,
 * och FELAR skriptet om "boundaries/dependencies" inte flaggar den.
 *
 * Testar med TVÅ olika `cwd`: repo-roten OCH tjänstens egen katalog.
 * CI:s faktiska "pnpm lint" (`turbo run lint`) kör varje paket-"eslint ."
 * FRÅN paketets egen katalog, inte från roten — ett tidigare fix som bara
 * testade cwd=REPO_ROOT missade därför att "boundaries/root-path" (utan en
 * ABSOLUT sökväg i eslint.config.js) gjorde reglerna verkningslösa just i
 * det faktiska CI-anropet, trots att de fungerade perfekt i det här
 * skriptet (hittat under Fas 5-reviewn). Samma klass bugg som den
 * ursprungliga: noll lint-fel ser likadant ut oavsett om det beror på
 * korrekt kod eller på att ingenting bevakas.
 *
 * Se docs/forsvar.md "Varför ett regressionstest för lagergränserna?".
 */
import { ESLint } from 'eslint';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_DIR = join(REPO_ROOT, 'services/booking-api');
const CONTROLLERS_DIR = join(SERVICE_DIR, 'src/controllers');
const REPOSITORIES_DIR = join(SERVICE_DIR, 'src/repositories');
const violationFile = join(CONTROLLERS_DIR, '__boundaries_regression_test__.controller.ts');
const repositoryFile = join(REPOSITORIES_DIR, '__boundaries_regression_test__.repository.ts');

function cleanup() {
  rmSync(violationFile, { force: true });
  rmSync(repositoryFile, { force: true });
}

async function catchesTheViolation(cwd) {
  const eslint = new ESLint({ cwd });
  const results = await eslint.lintFiles([violationFile]);
  const messages = results.flatMap((result) => result.messages);
  return {
    caught: messages.some((message) => message.ruleId === 'boundaries/dependencies'),
    messages,
  };
}

async function main() {
  mkdirSync(CONTROLLERS_DIR, { recursive: true });
  mkdirSync(REPOSITORIES_DIR, { recursive: true });
  writeFileSync(repositoryFile, 'export function dummyQuery(): string {\n  return "ok";\n}\n');
  writeFileSync(
    violationFile,
    [
      '// Avsiktligt brott, skrivet av scripts/verify-boundaries-enforcement.mjs.',
      "import { dummyQuery } from '../repositories/__boundaries_regression_test__.repository.js';",
      '',
      'export function violatesLayering(): string {',
      '  return dummyQuery();',
      '}',
      '',
    ].join('\n'),
  );

  for (const [label, cwd] of [
    ['repo-roten', REPO_ROOT],
    ['tjänstens egen katalog (= CI:s faktiska "eslint .")', SERVICE_DIR],
  ]) {
    const { caught, messages } = await catchesTheViolation(cwd);
    if (!caught) {
      console.error(
        `REGRESSION: "boundaries/dependencies" fångade INTE en avsiktlig lagerbrott-import när eslint körs med cwd=${label}.`,
      );
      console.error(
        'Lagergränserna i docs/rules.md §1 bevakas just nu av ingenting i det fallet. Meddelanden:',
      );
      console.error(JSON.stringify(messages, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    'OK: "boundaries/dependencies" fångade det avsiktliga lagerbrottet oavsett cwd (repo-rot och paketkatalog).',
  );
}

main()
  .catch((error) => {
    console.error('verify-boundaries-enforcement.mjs kraschade:', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
