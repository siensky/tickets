/**
 * Verifieringen (verify.mjs, verify-steps.mjs, verify-record.mjs) och Stop-hooken
 * (require-verify.mjs). Kärnan: ett miljöfel får aldrig se ut som ett testfel, posten får aldrig se ut
 * som ett bevis från CI, och en session som ändrat filer får inte sluta utan en post för just det trädet.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateCommand } from './guard.mjs';
import { sessionEditedFiles, stopDecision } from './require-verify.mjs';
import { MAX_RUNS, checkAttempts, formatReport, nextAttempts, runVerify } from './verify.mjs';
import { readRecord, treeHash, verifierHash, workingChanges } from './verify-record.mjs';
import { classify, failingTests, overallResult, planSteps } from './verify-steps.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const required = (steps) => steps.filter((s) => s.required).map((s) => s.name);

describe('planSteps', () => {
  it('kräver inga Docker-steg när bara dokumentation ändrats', () => {
    expect(required(planSteps(['docs/plan.md'], 'auto'))).toEqual([
      'lint',
      'typecheck',
      'unit',
      'claude-hooks',
    ]);
  });

  it('kräver integration och kontrakt när en tjänst ändrats', () => {
    expect(required(planSteps(['services/booking-api/src/x.ts'], 'auto'))).toEqual(
      expect.arrayContaining(['boundaries', 'integration', 'contract']),
    );
  });

  it('kräver alla steg med scope full', () => {
    expect(planSteps([], 'full').every((s) => s.required)).toBe(true);
  });
});

describe('classify och overallResult', () => {
  const unit = { kind: 'test' };
  const lint = { kind: 'static' };

  it('skiljer på godkänt, testfel, statiskt fel, miljöfel och timeout', () => {
    expect(classify(unit, { status: 0, output: '' })).toBe('passed');
    expect(classify(unit, { status: 1, output: 'FAIL x' })).toBe('test_failure');
    expect(classify(lint, { status: 1, output: 'error' })).toBe('static_failure');
    expect(classify(unit, { status: 1, output: 'Cannot connect to the Docker daemon' })).toBe(
      'env_error',
    );
    expect(classify(unit, { status: null, timedOut: true, output: '' })).toBe('timeout');
  });

  it('är passed bara när varje krävt steg gick igenom', () => {
    const step = (outcome, isRequired = true) => ({ outcome, required: isRequired });
    expect(overallResult([step('passed'), step('not_required', false)])).toBe('passed');
    expect(overallResult([step('passed'), step('env_error'), step('test_failure')])).toBe(
      'failed',
    );
    expect(overallResult([step('passed'), step('env_error')])).toBe('env_error');
    expect(overallResult([step('passed'), step('timeout')])).toBe('env_error');
    expect(overallResult([step('not_run')])).toBe('incomplete');
  });

  it('plockar ut fallerande tester ur Vitest-utdata', () => {
    const output = '\x1b[31m FAIL  tests/a.test.ts > gör x\x1b[0m\n ✓ ok\n × gör y 12ms\n';
    expect(failingTests(output)).toEqual(['FAIL  tests/a.test.ts > gör x', '× gör y']);
  });
});

describe('taket för försök', () => {
  it(`stoppar efter ${MAX_RUNS} körningar i rad utan grönt resultat`, () => {
    expect(checkAttempts({ branch: 'b', runsSinceGreen: MAX_RUNS }, 'b')).toMatchObject({
      allowed: false,
      stop: 'max_runs',
    });
    expect(checkAttempts({ branch: 'b', runsSinceGreen: MAX_RUNS - 1 }, 'b')).toMatchObject({
      allowed: true,
    });
  });

  it('stoppar när samma test fallerar igen efter en ändring, men inte vid en omkörning av samma träd', () => {
    const state = { branch: 'b', runsSinceGreen: 1, lastTree: 't1', lastFailures: ['× x'] };
    expect(
      nextAttempts(state, { branch: 'b', tree: 't2', result: 'failed', failures: ['× x'] })
        .stop,
    ).toBe('same_failure');
    expect(
      nextAttempts(state, { branch: 'b', tree: 't1', result: 'failed', failures: ['× x'] })
        .stop,
    ).toBeUndefined();
  });

  it('nollställs av ett grönt resultat och av en annan gren', () => {
    expect(
      nextAttempts(
        { branch: 'b', runsSinceGreen: 4 },
        { branch: 'b', tree: 't', result: 'passed', failures: [] },
      ).runsSinceGreen,
    ).toBe(0);
    expect(
      checkAttempts({ branch: 'a', runsSinceGreen: MAX_RUNS, stop: 'max_runs' }, 'b'),
    ).toMatchObject({ allowed: true, runsSinceGreen: 0 });
  });
});

const gitIn = (repo, args) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'verify-test-'));
  gitIn(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), '.claude/state/\n');
  mkdirSync(join(repo, 'services'));
  writeFileSync(join(repo, 'services/a.ts'), 'export const a = 1;\n');
  gitIn(repo, ['add', '.']);
  gitIn(repo, ['commit', '-q', '-m', 'init']);
  gitIn(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(repo, 'services/a.ts'), 'export const a = 2;\n');
  return repo;
}

describe('runVerify', () => {
  let repo;
  let calls;
  const passingExec = (command) => {
    calls.push(command.join(' '));
    return { status: 0, timedOut: false, output: '' };
  };

  beforeEach(() => {
    repo = tempRepo();
    calls = [];
  });

  it('skriver en lokal post för exakt det här trädet', () => {
    const record = runVerify({ cwd: repo, exec: passingExec, dockerCheck: () => true });
    expect(record).toMatchObject({
      result: 'passed',
      scope: 'local',
      ci: 'not_evaluated',
      branch: 'feature',
    });
    expect(record.treeHash).toBe(treeHash(repo, workingChanges(repo)));
    expect(record.verifierHash).toBe(verifierHash());
    expect(record.steps.find((s) => s.name === 'e2e')).toMatchObject({
      outcome: 'ci_only',
      required: false,
    });
    expect(readRecord(repo)).toEqual(record);
    expect(formatReport(record)).toContain(
      'Lokal verifiering: PASSED (lokal körning, inte CI',
    );
  });

  it('kör inga Docker-steg och ger env_error när Docker inte svarar', () => {
    const record = runVerify({ cwd: repo, exec: passingExec, dockerCheck: () => false });
    expect(record.result).toBe('env_error');
    expect(record.steps.find((s) => s.name === 'integration')).toMatchObject({
      outcome: 'env_error',
    });
    expect(calls).not.toContain('pnpm test:integration');
  });

  it('vägrar köra när taket är nått, och posten blir incomplete', () => {
    const failing = () => ({ status: 1, timedOut: false, output: ' × testet\n' });
    for (let run = 0; run < MAX_RUNS; run += 1) {
      writeFileSync(join(repo, 'services/a.ts'), `export const a = ${run + 10};\n`);
      runVerify({
        cwd: repo,
        exec:
          run === 0
            ? failing
            : () => ({ status: 1, timedOut: false, output: ` × test ${run}\n` }),
        dockerCheck: () => true,
      });
    }
    const record = runVerify({ cwd: repo, exec: passingExec, dockerCheck: () => true });
    expect(record.result).toBe('incomplete');
    expect(record.attempts.stop).toBe('max_runs');
    expect(calls).toEqual([]);
    expect(formatReport(record)).toContain('STOP:');
  });
});

describe('Stop-hooken', () => {
  const record = { treeHash: 't1', verifierHash: 'v1', result: 'passed', steps: [] };
  const base = {
    edited: true,
    changes: [{ path: 'services/a.ts' }],
    record,
    currentTree: 't1',
    currentVerifier: 'v1',
    isRetry: false,
  };

  it('släpper igenom när sessionen inte ändrat filer eller bara dokumentation', () => {
    expect(stopDecision({ ...base, edited: false, record: null })).toEqual({});
    expect(
      stopDecision({
        ...base,
        changes: [{ path: 'docs/plan.md' }, { path: 'README.md' }],
        record: null,
      }),
    ).toEqual({});
  });

  it('blockerar när posten saknas, gäller ett annat träd eller en annan version av skripten', () => {
    expect(stopDecision({ ...base, record: null }).block).toBe(true);
    expect(stopDecision({ ...base, currentTree: 't2' }).block).toBe(true);
    expect(stopDecision({ ...base, currentVerifier: 'v2' }).block).toBe(true);
  });

  it('blockerar inte en andra gång, men säger att verifieringen inte körts', () => {
    expect(stopDecision({ ...base, record: null, isRetry: true })).toEqual({
      message: expect.stringContaining('INTE KÖRD'),
    });
  });

  it('visar ett rött resultat för användaren men låter sessionen avslutas', () => {
    const failed = {
      ...record,
      result: 'env_error',
      steps: [{ name: 'integration', required: true, outcome: 'env_error' }],
    };
    expect(stopDecision({ ...base, record: failed })).toEqual({
      message: expect.stringContaining('ENV_ERROR (integration=env_error)'),
    });
  });
});

describe('require-verify.mjs som hook', () => {
  let repo;
  let transcript;

  beforeEach(() => {
    repo = tempRepo();
    transcript = join(repo, 'transcript.jsonl');
    const editCall = { message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } };
    writeFileSync(transcript, `${JSON.stringify(editCall)}\n`);
    writeFileSync(join(repo, '.gitignore'), '.claude/state/\ntranscript.jsonl\n');
  });

  const runHook = () =>
    spawnSync('node', [join(HOOKS, 'require-verify.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        cwd: repo,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      encoding: 'utf8',
    });

  it('blockerar avslutet utan post och släpper igenom efter en verifiering', () => {
    expect(JSON.parse(runHook().stdout)).toMatchObject({ decision: 'block' });
    runVerify({
      cwd: repo,
      exec: () => ({ status: 0, timedOut: false, output: '' }),
      dockerCheck: () => true,
    });
    expect(runHook().stdout).toBe('');
  });

  it('läser bara verktyg som ändrar filer ur transkriptet', () => {
    expect(sessionEditedFiles(transcript)).toBe(true);
    const bashOnly = join(repo, 'bash.jsonl');
    writeFileSync(
      bashOnly,
      `${JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n`,
    );
    expect(sessionEditedFiles(bashOnly)).toBe(false);
    expect(sessionEditedFiles(join(repo, 'saknas.jsonl'))).toBe(false);
  });

  afterEach(() => {
    expect(readFileSync(join(repo, 'services/a.ts'), 'utf8')).toContain('export const a');
  });
});

describe('posten skrivs bara av verify.mjs', () => {
  it.each([
    'echo \'{"result":"passed"}\' > .claude/state/verify-record.json',
    'rm .claude/state/verify-attempts.json',
    'cp fake.json .claude/state/verify-record.json',
    `node -e "require('fs').writeFileSync('.claude/state/verify-record.json', '{}')"`,
  ])('nekar %j', (command) => {
    expect(evaluateCommand(command)).toMatchObject({ decision: 'deny', rule: 'verify-state' });
  });

  it('släpper igenom läsning av posten', () => {
    expect(evaluateCommand('cat .claude/state/verify-record.json')).toBeNull();
  });
});
