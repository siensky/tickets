/**
 * Lokal verifiering (ADR-0012, `/verify`): kör CI:s kontroller (utom e2e) för det som ändrats, klassar
 * varje steg (godkänt, testfel, miljöfel, timeout, inte krävt, bara i CI) och skriver en
 * verifieringspost för exakt det filträdet. Stop-hooken (require-verify.mjs) kräver att posten finns.
 *
 * Fallgrop: taket för försök räknas här, inte av modellen. Efter MAX_RUNS körningar i rad utan grönt
 * resultat, eller när samma test fallerar igen efter en ändring, vägrar skriptet köra tills användaren
 * tar bort .claude/state/verify-attempts.json. Kommandot har inga flaggor som byter ut stegen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CI_ONLY, classify, failingTests, overallResult, planSteps } from './verify-steps.mjs';
import {
  RECORD_KIND,
  git,
  repoRoot,
  statePath,
  treeHash,
  verifierHash,
  workingChanges,
  writeRecord,
} from './verify-record.mjs';

export const MAX_RUNS = 6;
const OUTPUT_TAIL = 256 * 1024;

/**
 * Försöksräknaren. Saknas filen börjar räknaren om; finns den men går inte att läsa (tom, trasig) räknas
 * det som ett stopp, så att en förstörd fil aldrig tar bort taket.
 */
export function readAttempts(file) {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state !== null && typeof state === 'object' && !Array.isArray(state)) return state;
  } catch {
    // Behandlas som trasig nedan.
  }
  return { runsSinceGreen: MAX_RUNS, stop: 'corrupt_state', lastFailures: [] };
}

function mergeBase(repo) {
  for (const ref of ['main', 'origin/main']) {
    try {
      return git(repo, ['merge-base', 'HEAD', ref]).trim();
    } catch {
      // Prova nästa referens.
    }
  }
  return null;
}

/**
 * Sökvägar som grenen ändrat jämfört med main, plus ändringarna i arbetskatalogen. `null` när det inte
 * finns någon main att jämföra med; då körs alla steg i stället för att gissa.
 */
function changedPaths(repo, changes) {
  const base = mergeBase(repo);
  if (base === null) return null;
  const committed = git(repo, ['diff', '--name-only', base, 'HEAD'])
    .split('\n')
    .filter(Boolean);
  return [...new Set([...committed, ...changes.map((c) => c.path)])];
}

function realExec(command, { cwd, timeoutMs }) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  return {
    status: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    errorCode: result.error?.code,
    signal: result.signal,
    output: output.slice(-OUTPUT_TAIL),
  };
}

function realDockerCheck() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 10_000,
  });
  return result.status === 0;
}

/**
 * Om körningen får starta. Räknaren gäller oberoende av gren: ett grenbyte nollställer den inte, bara
 * ett grönt resultat eller att användaren tar bort filen.
 */
export function checkAttempts(state) {
  if (state === null || typeof state !== 'object') return { allowed: true, runsSinceGreen: 0 };
  const runsSinceGreen = state.runsSinceGreen ?? 0;
  if (state.stop) return { allowed: false, stop: state.stop, runsSinceGreen };
  if (runsSinceGreen >= MAX_RUNS) return { allowed: false, stop: 'max_runs', runsSinceGreen };
  return { allowed: true, runsSinceGreen };
}

export function nextAttempts(state, { branch, tree, result, failures }) {
  if (result === 'passed')
    return { branch, runsSinceGreen: 0, lastTree: tree, lastFailures: [] };
  const previous = state ?? { runsSinceGreen: 0, lastFailures: [] };
  const isSameFailure =
    failures.length > 0 &&
    previous.lastTree !== tree &&
    JSON.stringify(previous.lastFailures) === JSON.stringify(failures);
  return {
    branch,
    runsSinceGreen: (previous.runsSinceGreen ?? 0) + 1,
    lastTree: tree,
    lastFailures: failures,
    stop: isSameFailure ? 'same_failure' : undefined,
  };
}

const describe = (step) => ({
  name: step.name,
  command: step.command.join(' '),
  required: step.required,
  reason: step.reason,
});

function runSteps(planned, { repo, exec, dockerCheck }) {
  let isDockerUp;
  return planned.map((step) => {
    const base = describe(step);
    if (!step.required) return { ...base, outcome: 'not_required', durationMs: 0, failed: [] };
    isDockerUp ??= step.docker ? dockerCheck() : undefined;
    if (step.docker && !isDockerUp) {
      return {
        ...base,
        outcome: 'env_error',
        durationMs: 0,
        failed: [],
        note: 'Docker svarar inte.',
      };
    }
    const started = Date.now();
    const result = exec(step.command, { cwd: repo, timeoutMs: step.timeoutMs });
    const outcome = classify(step, result);
    const failed = outcome === 'test_failure' ? failingTests(result.output) : [];
    return {
      ...base,
      outcome,
      exitCode: result.status,
      durationMs: Date.now() - started,
      failed,
    };
  });
}

function buildRecord({ repo, branch, tree, scope, startedAt, steps, result, attempts }) {
  const ciOnly = CI_ONLY.map((c) => ({
    ...c,
    required: false,
    outcome: 'ci_only',
    durationMs: 0,
    failed: [],
  }));
  return {
    kind: RECORD_KIND,
    schema: 1,
    scope: 'local',
    ci: 'not_evaluated',
    note: 'Lokal körning, inte ett bevis. GitHub Actions ci-ok avgör.',
    result,
    branch,
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    treeHash: tree,
    verifierHash: verifierHash(),
    requestedScope: scope,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: [...steps, ...ciOnly],
    attempts,
  };
}

/** Kör verifieringen och skriver posten. `exec` och `dockerCheck` går bara att byta ut från tester. */
export function runVerify({
  cwd,
  scope = 'auto',
  exec = realExec,
  dockerCheck = realDockerCheck,
}) {
  const startedAt = new Date().toISOString();
  const repo = repoRoot(cwd);
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const changes = workingChanges(repo);
  const tree = treeHash(repo, changes);
  const attemptsFile = statePath(repo, 'verify-attempts.json');
  const state = readAttempts(attemptsFile);
  const gate = checkAttempts(state);
  const changed = changedPaths(repo, changes);
  const planned =
    changed === null
      ? planSteps([], 'full', 'ingen main att jämföra med: alla steg')
      : planSteps(changed, scope);
  const steps = gate.allowed
    ? runSteps(planned, { repo, exec, dockerCheck })
    : planned.map((step) => ({
        ...describe(step),
        outcome: 'not_run',
        durationMs: 0,
        failed: [],
      }));
  const result = gate.allowed ? overallResult(steps) : 'incomplete';
  const failures = steps.flatMap((step) => step.failed);
  const next = gate.allowed ? nextAttempts(state, { branch, tree, result, failures }) : state;
  const stop = next.stop ?? gate.stop ?? null;
  const attempts = { runsSinceGreen: next.runsSinceGreen, max: MAX_RUNS, stop };
  const record = buildRecord({
    repo,
    branch,
    tree,
    scope,
    startedAt,
    steps,
    result,
    attempts,
  });
  writeRecord(repo, record);
  writeFileSync(attemptsFile, `${JSON.stringify(next, null, 2)}\n`);
  return record;
}

const STOP_TEXT = {
  max_runs: `STOP: ${MAX_RUNS} körningar i rad utan grönt resultat.`,
  same_failure: 'STOP: samma test fallerar igen efter en ändring.',
  corrupt_state: 'STOP: försöksräknaren går inte att läsa.',
};

export function formatReport(record) {
  const seconds = (ms) => (ms > 0 ? `${Math.round(ms / 1000)}s` : '–');
  const rows = record.steps.map(
    (s) =>
      `  ${s.name.padEnd(18)} ${s.outcome.padEnd(15)} ${seconds(s.durationMs).padStart(5)}  ${s.note ?? s.reason}`,
  );
  const failed = record.steps.flatMap((s) => s.failed.map((name) => `  ${s.name}: ${name}`));
  const stop = record.attempts.stop;
  return [
    `Lokal verifiering: ${record.result.toUpperCase()} (lokal körning, inte CI; GitHub Actions ci-ok avgör)`,
    ...rows,
    ...(failed.length > 0 ? ['Fallerande tester:', ...failed] : []),
    `Försök utan grönt resultat: ${record.attempts.runsSinceGreen} av ${record.attempts.max}`,
    ...(stop
      ? [
          `${STOP_TEXT[stop]} Fråga användaren. Taket nollställs när användaren tar bort .claude/state/verify-attempts.json.`,
        ]
      : []),
    `Post: .claude/state/verify-record.json (träd ${record.treeHash})`,
    'Återge raden "Lokal verifiering: …" och tabellen ordagrant i rapporten.',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const isFull = args.length === 2 && args[0] === '--scope' && args[1] === 'full';
  if (args.length > 0 && !isFull) {
    process.stderr.write('Användning: node .claude/hooks/verify.mjs [--scope full]\n');
    process.exit(2);
  }
  const record = runVerify({ cwd: process.cwd(), scope: isFull ? 'full' : 'auto' });
  process.stdout.write(`${formatReport(record)}\n`);
  process.exit(record.result === 'passed' ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
