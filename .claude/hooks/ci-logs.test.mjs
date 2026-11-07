/**
 * Tester för CI-läsningen (ADR-0014). `gh` byts mot en fejk, så inget går mot GitHub och `realGh` körs
 * aldrig. Testerna låser vilka anrop koden gör och vilken miljö `gh` får, inte vad `gh` själv gör.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ghEnvironment, groupFailedLog, readCiFailure } from './ci-logs.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const HEAD = 'adc4b43aaaaaaaa';
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const RED_RUN = {
  databaseId: 42,
  status: 'completed',
  conclusion: 'failure',
  workflowName: 'CI',
};
const RUN = {
  databaseId: 42,
  event: 'pull_request',
  headSha: HEAD,
  workflowName: 'CI',
  jobs: [
    {
      name: 'k8s-dry-run',
      conclusion: 'failure',
      steps: [
        { name: 'Checkout', conclusion: 'success' },
        { name: 'Dry-run', conclusion: 'failure' },
      ],
    },
    {
      name: 'e2e (fast)',
      conclusion: 'timed_out',
      steps: [{ name: 'Run the e2e suite', conclusion: 'timed_out' }],
    },
    { name: 'test / static', conclusion: 'success', steps: [] },
  ],
};
const logLine = (text, job = 'k8s-dry-run') =>
  `${job}\tDry-run\t2026-11-07T17:34:11.5445584Z ${text}`;
const LOG = [
  logLine('deployment.apps/x configured'),
  logLine('The Deployment is invalid: Invalid value: ""'),
  logLine('Error: token=hemligt123'),
  logLine('##[error]Process completed with exit code 1.'),
].join('\n');

function fakeGh({ runs = [RED_RUN], log = LOG, onDownload } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'list') return ok(JSON.stringify(runs));
    if (args.includes('--json')) return ok(JSON.stringify(RUN));
    if (args.includes('--log-failed')) return ok(log);
    if (onDownload === undefined) return { status: 1, stdout: '', stderr: 'no artifacts' };
    onDownload(args[args.indexOf('--dir') + 1]);
    return ok('');
  };
  return { gh, calls };
}

describe('groupFailedLog', () => {
  it('grupperar per jobb och tar bort tidsstämpeln', () => {
    const jobs = groupFailedLog(LOG);
    expect([...jobs.keys()]).toEqual(['k8s-dry-run']);
    expect(jobs.get('k8s-dry-run')[0]).toBe('deployment.apps/x configured');
  });

  it('hoppar över rader utan jobb och steg', () => {
    expect(groupFailedLog('bara text\n\n').size).toBe(0);
  });
});

describe('ghEnvironment', () => {
  it('ärver inget som styr värd, konfiguration, proxy, token eller program', () => {
    const env = ghEnvironment({
      HOME: '/home/x',
      USER: 'x',
      PATH: '/evil',
      GH_HOST: 'evil.example',
      GH_CONFIG_DIR: '/evil',
      GH_TOKEN: 'hemligt',
      HTTPS_PROXY: 'http://evil.example',
      NODE_OPTIONS: '--require /evil',
    });
    expect(Object.keys(env).sort()).toEqual([
      'GH_HOST',
      'GH_PROMPT_DISABLED',
      'HOME',
      'PATH',
      'USER',
    ]);
    expect(env.GH_HOST).toBe('github.com');
    expect(env.PATH).not.toContain('/evil');
  });
});

describe('readCiFailure', () => {
  let repo;
  const logFile = () => join(repo, '.claude/state/ci-failure.log');
  const read = (gh) => readCiFailure({ repo, branch: 'x', head: HEAD, gh });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ci-logs-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('visar röda jobb och steg, felraderna och var utdraget ligger', () => {
    const report = read(fakeGh().gh);
    expect(report).toContain('RÖTT k8s-dry-run (failure): Dry-run');
    expect(report).toContain('RÖTT e2e (fast) (timed_out): Run the e2e suite');
    expect(report).toContain('Invalid value');
    expect(report).toContain('Gäller aktuell HEAD.');
    expect(report).not.toContain('test / static');
    expect(report).not.toContain('configured');
  });

  it('varnar när felet gäller en annan commit än HEAD', () => {
    const report = readCiFailure({ repo, branch: 'x', head: 'annan', gh: fakeGh().gh });
    expect(report).toContain('gäller inte aktuell HEAD');
  });

  it('rensar hemligheter ur både rapporten och utdraget', () => {
    const report = read(fakeGh().gh);
    const log = readFileSync(logFile(), 'utf8');
    expect(report).not.toContain('hemligt123');
    expect(log).not.toContain('hemligt123');
    expect(log).toContain('### k8s-dry-run');
  });

  it('rensar före kapning, så att en lång rad inte läcker det som kapats fram', () => {
    const url = `Error: ${'x'.repeat(200)} postgres://app:losen123456789012345678901@db/tickets`;
    expect(read(fakeGh({ log: logLine(url) }).gh)).not.toContain('losen');
  });

  it('rensar GitHub-tokens', () => {
    const token = `Error: ghs_${'a'.repeat(30)} github_pat_${'b'.repeat(30)}`;
    const report = read(fakeGh({ log: logLine(token) }).gh);
    expect(report).not.toContain('ghs_a');
    expect(report).not.toContain('github_pat_b');
  });

  it('anropar bara läsande gh-kommandon mot det fasta repot', () => {
    const { gh, calls } = fakeGh();
    read(gh);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args[0]).toBe('run');
      expect(['list', 'view', 'download']).toContain(args[1]);
      expect(args[args.indexOf('--repo') + 1]).toBe('siensky/tickets');
    }
  });

  it('tar med Playwrights error-context, rensad och begränsad, och städar katalogen', () => {
    let downloaded = '';
    const onDownload = (dir) => {
      downloaded = dir;
      const report = join(dir, 'playwright-report-fast', 'scanner');
      mkdirSync(report, { recursive: true });
      writeFileSync(
        join(report, 'error-context.md'),
        `password=hemligt ${'y'.repeat(20_000)}`,
      );
    };
    read(fakeGh({ onDownload }).gh);
    const log = readFileSync(logFile(), 'utf8');
    expect(log).toContain(
      '### error-context: playwright-report-fast/scanner/error-context.md',
    );
    expect(log).not.toContain('hemligt');
    expect(
      log.match(/y+/g).reduce((a, b) => (a.length > b.length ? a : b)).length,
    ).toBeLessThan(8200);
    expect(existsSync(downloaded)).toBe(false);
  });

  it('följer inte en symlänk i artefakten', () => {
    const secret = join(repo, 'hemlig.txt');
    writeFileSync(secret, 'lokal-hemlighet');
    const onDownload = (dir) => symlinkSync(secret, join(dir, 'error-context.md'));
    read(fakeGh({ onDownload }).gh);
    expect(readFileSync(logFile(), 'utf8')).not.toContain('lokal-hemlighet');
  });

  it('säger till när artefakten saknas, utan att fallera', () => {
    expect(read(fakeGh().gh)).toContain(
      'Playwright-artefakt: kunde inte hämtas eller saknas.',
    );
  });

  it('begränsar rapport och utdrag och markerar kapningen', () => {
    const jobs = ['k8s-dry-run', 'e2e (fast)', 'a', 'b', 'c', 'd', 'e', 'f'];
    const long = jobs.flatMap((job) =>
      Array.from({ length: 200 }, (_, i) =>
        logLine(`Error: rad ${i} ${'z'.repeat(200)}`, job),
      ),
    );
    const report = read(fakeGh({ log: long.join('\n') }).gh);
    const log = readFileSync(logFile(), 'utf8');
    expect(report).toContain('[kapat, resten står i utdraget]');
    expect(report).toContain('Utdrag: .claude/state/ci-failure.log');
    expect(report.length).toBeLessThan(9000);
    expect(log).toContain('[kapat, början saknas]');
    expect(log.trimEnd().endsWith('[kapat]')).toBe(true);
    expect(log.length).toBeLessThan(100 * 1024);
  });

  it('skriver körning och commit först i utdraget', () => {
    read(fakeGh().gh);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/^Körning 42, commit adc4b43\n/);
  });

  it('tar bort ett gammalt utdrag även när grenen saknar körningar', () => {
    read(fakeGh().gh);
    read(fakeGh({ runs: [] }).gh);
    expect(existsSync(logFile())).toBe(false);
  });

  it('säger när grenen saknar röda körningar och tar bort ett gammalt utdrag', () => {
    read(fakeGh().gh);
    expect(existsSync(logFile())).toBe(true);
    const runs = [{ ...RED_RUN, conclusion: 'success' }];
    const { gh, calls } = fakeGh({ runs });
    expect(read(gh)).toContain('ingen röd körning');
    expect(calls).toHaveLength(1);
    expect(existsSync(logFile())).toBe(false);
  });

  it('säger när grenen saknar körningar', () => {
    expect(read(fakeGh({ runs: [] }).gh)).toContain('Är grenen pushad?');
  });

  it('räknar en körning med timeout som röd', () => {
    const runs = [{ ...RED_RUN, conclusion: 'timed_out' }];
    expect(read(fakeGh({ runs }).gh)).toContain('Senaste röda: 42');
  });

  it('kastar ett läsbart fel utan hemligheter när gh inte når GitHub', () => {
    const gh = () => ({ status: 1, stdout: '', stderr: 'bad credentials token=abc123' });
    expect(() => read(gh)).toThrow(/bad credentials/);
    expect(() => read(gh)).not.toThrow(/abc123/);
  });
});

describe('kommandoraden', () => {
  it.each([['--repo', 'annat/repo'], ['--help'], ['42']])('vägrar argument: %s', (...args) => {
    const result = spawnSync(process.execPath, [join(HOOKS, 'ci-logs.mjs'), ...args], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Användning');
  });
});
