#!/usr/bin/env node
/**
 * Regressionstest för eslint-plugin-boundaries (rules.md §1: lagergränser
 * controllers -> services -> repositories). Skriver en avsiktlig, förbjuden
 * import (controllers importerar direkt från repositories/) till en
 * tillfällig fil i en riktig service, lintar den med riktiga ESLint-API:et,
 * och FELAR skriptet om "boundaries/dependencies" inte flaggar den.
 *
 * Finns eftersom konfigurationen tidigare INTE bevakade någonting alls —
 * noll lint-fel såg ut som "inga brott" när det egentligen var "ingenting
 * bevakas" (fel API-form för v7 + en TypeScript-resolver som saknades, så
 * varje ".js"-import av en ".ts"-fil var osynlig för pluginet). Se
 * docs/forsvar.md "Varför ett regressionstest för lagergränserna?".
 */
import { ESLint } from 'eslint';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLERS_DIR = join(REPO_ROOT, 'services/booking-api/src/controllers');
const REPOSITORIES_DIR = join(REPO_ROOT, 'services/booking-api/src/repositories');
const violationFile = join(CONTROLLERS_DIR, '__boundaries_regression_test__.controller.ts');
const repositoryFile = join(REPOSITORIES_DIR, '__boundaries_regression_test__.repository.ts');

function cleanup() {
  rmSync(violationFile, { force: true });
  rmSync(repositoryFile, { force: true });
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

  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintFiles([violationFile]);
  const messages = results.flatMap((result) => result.messages);
  const caught = messages.some((message) => message.ruleId === 'boundaries/dependencies');

  if (!caught) {
    console.error(
      'REGRESSION: "boundaries/dependencies" fångade INTE en avsiktlig lagerbrott-import.',
    );
    console.error(
      'Lagergränserna i docs/rules.md §1 bevakas just nu av ingenting. Meddelanden:',
    );
    console.error(JSON.stringify(messages, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(
    'OK: "boundaries/dependencies" fångade det avsiktliga lagerbrottet som förväntat.',
  );
}

main()
  .catch((error) => {
    console.error('verify-boundaries-enforcement.mjs kraschade:', error);
    process.exitCode = 1;
  })
  .finally(cleanup);
