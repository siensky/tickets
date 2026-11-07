/**
 * Läser den senaste misslyckade GitHub Actions-körningen på aktuell gren (ADR-0014): jobb, röda steg,
 * felrader och Playwrights error-context. Utdraget hamnar i .claude/state/ci-failure.log.
 *
 * Fallgrop: skriptet körs utanför sandboxen med utvecklarens `gh`-inloggning, som kan pusha och merga.
 * Därför tar det inga argument, får en egen miljö (GH_HOST, GH_CONFIG_DIR och proxy ärvs inte) och anropar
 * bara `gh run list`, `view` och `download` mot ett fast repo. Loggar och artefakter är opålitlig text.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, redact, repoRoot, statePath } from './verify-record.mjs';

export const GITHUB_REPO = 'siensky/tickets';
export const CI_LOG = '.claude/state/ci-failure.log';
const GH_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const RECENT_RUNS = 10;
const MAX_ERROR_LINES = 30;
const ERROR_LINE_LENGTH = 240;
const REPORT_BYTES = 8 * 1024;
const LOG_BYTES_PER_JOB = 16 * 1024;
const LOG_BYTES_TOTAL = 96 * 1024;
const MAX_ERROR_CONTEXTS = 4;
const ERROR_CONTEXT_BYTES = 8 * 1024;
const GH_TIMEOUT_MS = 60_000;
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const ERROR_LINE =
  /##\[error\]|\bError:|\berror:|Invalid value|\bFAIL\b|\b\d+ (failed|flaky)\b|\.spec\.ts:\d+|Locator:/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/** Bara det `gh` behöver för inloggningen. Inget som styr värd, konfiguration, proxy eller program ärvs. */
export function ghEnvironment(env) {
  return {
    HOME: env.HOME,
    USER: env.USER,
    PATH: GH_PATH,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
  };
}

function realGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: ghEnvironment(process.env),
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? result.error.message : ''}`,
  };
}

function readOutput(gh, args) {
  const result = gh(args);
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${redact(result.stderr).slice(-500)}`);
  }
  return result.stdout;
}

/** `gh run view --log-failed` ger `jobb<TAB>steg<TAB>tid text`. Raderna grupperas per jobb. */
export function groupFailedLog(text) {
  const jobs = new Map();
  for (const line of text.split('\n')) {
    const [job, , ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    const content = rest
      .join('\t')
      .replace(TIMESTAMP, '')
      .replace(/\x1b\[[0-9;]*m/g, '');
    jobs.set(job, [...(jobs.get(job) ?? []), content]);
  }
  return jobs;
}

// Rensas före kapning: en kapad JWT eller URL känns annars inte igen.
const errorLines = (lines) =>
  lines
    .filter((line) => ERROR_LINE.test(line))
    .map((line) => redact(line).trim().slice(0, ERROR_LINE_LENGTH))
    .slice(-MAX_ERROR_LINES);

const redJobs = (run) =>
  run.jobs
    .filter((job) => RED_CONCLUSIONS.has(job.conclusion))
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      steps: job.steps
        .filter((step) => RED_CONCLUSIONS.has(step.conclusion))
        .map((step) => step.name),
    }));

const capped = (text, bytes, note = '') =>
  text.length > bytes ? `${text.slice(0, bytes)}\n[kapat${note}]` : text;
const lastPart = (text, bytes) =>
  text.length > bytes ? `[kapat, början saknas]\n${text.slice(-bytes)}` : text;

/** Playwrights sidbeskrivning när testet föll. Bara vanliga filer läses, aldrig en symlänk. */
function readErrorContexts(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'error-context.md')
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .slice(-MAX_ERROR_CONTEXTS)
    .map((path) => ({
      path: relative(dir, path),
      text: capped(redact(readFileSync(path, 'utf8')), ERROR_CONTEXT_BYTES),
    }));
}

function downloadErrorContexts(gh, runId) {
  const dir = mkdtempSync(join(tmpdir(), 'tikknet-ci-'));
  try {
    const download = gh([
      'run',
      'download',
      runId,
      '--repo',
      GITHUB_REPO,
      '--pattern',
      'playwright-report-*',
      '--dir',
      dir,
    ]);
    return download.status === 0 ? readErrorContexts(dir) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLog(repo, run, logByJob, contexts) {
  const header = `Körning ${String(run.databaseId)}, commit ${run.headSha.slice(0, 7)}`;
  const sections = [...logByJob].map(
    ([job, lines]) => `### ${job}\n${lastPart(redact(lines.join('\n')), LOG_BYTES_PER_JOB)}`,
  );
  const pages = contexts.map(({ path, text }) => `### error-context: ${path}\n${text}`);
  mkdirSync(statePath(repo, ''), { recursive: true });
  writeFileSync(
    statePath(repo, 'ci-failure.log'),
    `${capped([header, ...sections, ...pages].join('\n\n'), LOG_BYTES_TOTAL)}\n`,
  );
}

function formatReport({ branch, head, latest, run, logByJob, contexts }) {
  const isCurrent = run.headSha === head;
  const lines = [
    `CI ${branch}: senaste körningen ${String(latest.databaseId)} (${latest.workflowName}): ${latest.status} ${latest.conclusion ?? ''}`.trimEnd(),
    `Senaste röda: ${String(run.databaseId)} (${run.workflowName}, ${run.event}), commit ${run.headSha.slice(0, 7)}`,
    isCurrent
      ? 'Gäller aktuell HEAD.'
      : 'OBS: gäller inte aktuell HEAD, felet kan vara gammalt.',
  ];
  for (const { name, conclusion, steps } of redJobs(run)) {
    lines.push(`RÖTT ${name} (${conclusion}): ${steps.join(', ') || 'inget steg angivet'}`);
    lines.push(...errorLines(logByJob.get(name) ?? []).map((line) => `  ${line}`));
  }
  if (contexts === null) lines.push('Playwright-artefakt: kunde inte hämtas eller saknas.');
  return `${capped(lines.join('\n'), REPORT_BYTES, ', resten står i utdraget')}\nUtdrag: ${CI_LOG}`;
}

/** Hämtar och skriver utdraget. Inga argument kommer utifrån: gren och HEAD läses ur git. */
export function readCiFailure({ repo, branch, head, gh = realGh }) {
  const runs = JSON.parse(
    readOutput(gh, [
      'run',
      'list',
      '--repo',
      GITHUB_REPO,
      '--branch',
      branch,
      '--limit',
      String(RECENT_RUNS),
      '--json',
      'databaseId,status,conclusion,workflowName',
    ]),
  );
  // Ett gammalt utdrag får aldrig se ut att gälla den här grenen eller körningen.
  rmSync(statePath(repo, 'ci-failure.log'), { force: true });
  if (runs.length === 0) {
    return `CI ${branch}: inga körningar hittades. Är grenen pushad?`;
  }
  const red = runs.find((run) => RED_CONCLUSIONS.has(run.conclusion));
  if (red === undefined) {
    return `CI ${branch}: ingen röd körning bland de senaste ${String(runs.length)}.`;
  }
  const id = String(red.databaseId);
  const view = ['run', 'view', id, '--repo', GITHUB_REPO];
  const run = JSON.parse(
    readOutput(gh, [...view, '--json', 'databaseId,event,headSha,jobs,workflowName']),
  );
  const logByJob = groupFailedLog(readOutput(gh, [...view, '--log-failed']));
  const contexts = downloadErrorContexts(gh, id);
  writeLog(repo, run, logByJob, contexts ?? []);
  return formatReport({ branch, head, latest: runs[0], run, logByJob, contexts });
}

function main() {
  if (process.argv.length > 2) {
    process.stderr.write('Användning: node <repo>/.claude/hooks/ci-logs.mjs\n');
    process.exit(2);
  }
  try {
    const repo = repoRoot(process.cwd());
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch === 'HEAD') throw new Error('detached HEAD, ingen gren att läsa CI för');
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    process.stdout.write(`${readCiFailure({ repo, branch, head })}\n`);
  } catch (error) {
    const hint = /operation not permitted/i.test(error.message)
      ? '\nKördes i sandboxen: installera om managed settings och starta om Claude Code (docs/runbook.md).'
      : '';
    process.stderr.write(`Kunde inte läsa CI: ${error.message}${hint}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
