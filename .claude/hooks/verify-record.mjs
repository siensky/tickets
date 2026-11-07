/**
 * Verifieringsposten (ADR-0012): vad `verify.mjs` körde, mot exakt vilket filträd och med vilket
 * utfall. Delas av verify.mjs (skriver) och require-verify.mjs (Stop-hooken, läser).
 *
 * Fallgrop: posten är ett lokalt kvitto, aldrig ett bevis. `scope: "local"` och `ci: "not_evaluated"`
 * står i varje post, och GitHub Actions `ci-ok` avgör. Posten gäller bara för filträdet den skrevs för:
 * ändras en fil, HEAD eller själva verifieringsskripten blir den ogiltig.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFIER_FILES = ['verify.mjs', 'verify-steps.mjs', 'verify-record.mjs'];

export const RECORD_KIND = 'local-verify-record';
export const RESULTS = ['passed', 'failed', 'env_error', 'incomplete'];

export const statePath = (repo, name) => join(repo, '.claude', 'state', name);

export function git(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** Ändrade, nya och borttagna filer i arbetskatalogen jämfört med HEAD (gitignorerade räknas inte). */
export function workingChanges(repo) {
  const entries = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split(
    '\0',
  );
  const changes = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    changes.push({ status, path: entry.slice(3) });
    if (status.startsWith('R') || status.startsWith('C')) i += 1;
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Hash av verifieringsskripten själva: ändras de, gäller inga gamla poster. */
export function verifierHash() {
  const hash = createHash('sha256');
  for (const file of VERIFIER_FILES)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(HOOKS_DIR, file)));
  return hash.digest('hex').slice(0, 16);
}

/** Fingeravtryck av filträdet: HEAD plus innehållet i varje ändrad eller ny fil. */
export function treeHash(repo, changes = workingChanges(repo)) {
  const hash = createHash('sha256').update(git(repo, ['rev-parse', 'HEAD']).trim());
  for (const { path } of changes) {
    const full = join(repo, path);
    hash.update('\0').update(path).update('\0');
    hash.update(existsSync(full) ? readFileSync(full) : 'deleted');
  }
  return hash.digest('hex').slice(0, 16);
}

export function readRecord(repo) {
  const file = statePath(repo, 'verify-record.json');
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.kind === RECORD_KIND && RESULTS.includes(record.result) ? record : null;
  } catch {
    return null;
  }
}

export const FAILURE_LOG = '.claude/state/verify-failure.log';
const LOG_BYTES_PER_STEP = 8 * 1024;
const LOG_BYTES_TOTAL = 32 * 1024;
// Bästa möjliga rensning, ingen garanti: nyckel=värde för namn som låter hemliga, Bearer, nyckelblock,
// JWT, vanliga nyckelprefix och inloggning i URL:er.
const REDACTIONS = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redigerat]',
  ],
  // Hela raden för rubriker där värdet kan innehålla mellanslag (`Authorization: Bearer …`).
  [/^([+\-\s]*"?(?:authorization|cookie|set-cookie)"?\s*[:=]).*$/gim, '$1 [redigerat]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redigerat]'],
  [
    /(secret|token|password|passwd|api[_-]?key|credential|(?:client-)?(?:key|certificate)-data)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    '$1$2[redigerat]',
  ],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redigerat]'],
  [
    /\b(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|xox[abp]-|AKIA)[\w-]+/g,
    '[redigerat]',
  ],
  [/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[redigerat]@'],
];

export const redact = (text) =>
  REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

/**
 * Utdatan från steg som inte blev gröna, för felsökning utan ny körning. En enda fil som skrivs över
 * varje körning (och tas bort när allt blev grönt), högst LOG_BYTES_TOTAL, och gitignorerad.
 */
export function writeFailureLog(repo, entries) {
  const file = statePath(repo, 'verify-failure.log');
  if (entries.length === 0) {
    rmSync(file, { force: true });
    return null;
  }
  const sections = entries.map(
    ({ name, command, outcome, output }) =>
      `### ${name} (${outcome}): ${command}\n${redact(output).slice(-LOG_BYTES_PER_STEP)}`,
  );
  mkdirSync(statePath(repo, ''), { recursive: true });
  writeFileSync(file, `${sections.join('\n\n').slice(0, LOG_BYTES_TOTAL)}\n`);
  return FAILURE_LOG;
}

export function writeRecord(repo, record) {
  mkdirSync(statePath(repo, ''), { recursive: true });
  writeFileSync(statePath(repo, 'verify-record.json'), `${JSON.stringify(record, null, 2)}\n`);
  appendFileSync(statePath(repo, 'verify-history.jsonl'), `${JSON.stringify(record)}\n`);
}
