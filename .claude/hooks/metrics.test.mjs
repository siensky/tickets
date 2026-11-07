/**
 * Mätningen (metrics.mjs) och rapporten (metrics-report.mjs). Kärnan: inget känsligt får hamna i
 * loggen, ett fel i mätningen får aldrig stoppa arbetet, och tokens räknas exakt en gång per svar
 * eller redovisas som ej mätta.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeSession, formatReport, loadEntries } from './metrics-report.mjs';
import { bashCategory, entryFor, readUsage, safePath, toolEntry } from './metrics.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const REPO = '/repo';
const NOW = new Date('2026-11-07T12:00:00.000Z');
const SENSITIVE = 'kanslig-markortext';

const tool = (fields) => ({
  ts: '2026-11-07T12:00:00.000Z',
  event: 'tool',
  session: 's1',
  outcome: 'ok',
  ...fields,
});
const read = (path, fields = {}) => tool({ tool: 'Read', path, ...fields });
const edit = (path) => tool({ tool: 'Edit', path });
const verify = (outcome = 'ok') => tool({ tool: 'Bash', category: 'verify', outcome });
const assistantLine = (id, usage) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, usage, content: [{ text: SENSITIVE }] },
  });
const USAGE = {
  input_tokens: 2,
  output_tokens: 10,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 1000,
};

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrics-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('safePath', () => {
  it('sparar en sökväg i repot relativt repot', () => {
    expect(safePath('/repo/docs/plan.md', REPO, 's')).toBe('docs/plan.md');
  });

  it.each([
    '/Users/x/.ssh/id_rsa',
    '/repo/../annat/fil.txt',
    '/repo/.env',
    '/repo/infra/terraform/terraform.tfstate',
    `/repo/${'a'.repeat(301)}`,
    '/repo',
    '~/annat/fil.txt',
    '~annan/fil.txt',
    '$HOME/annat/fil.txt',
    '../annat/fil.txt',
    'docs/plan.md',
  ])('hashar %s', (path) => {
    expect(safePath(path, REPO, 's')).toMatch(/^hash:[0-9a-f]{16}$/);
  });

  it('ger olika hash i olika sessioner men samma inom en session', () => {
    const path = '/Users/x/fil.txt';
    expect(safePath(path, REPO, 'a')).toBe(safePath(path, REPO, 'a'));
    expect(safePath(path, REPO, 'a')).not.toBe(safePath(path, REPO, 'b'));
  });

  it('ger ingen sökväg för ett värde som inte är en text', () => {
    expect(safePath(undefined, REPO, 's')).toBeUndefined();
    expect(safePath(7, REPO, 's')).toBeUndefined();
  });
});

describe('bashCategory', () => {
  it.each([
    ['node .claude/hooks/verify.mjs', 'verify'],
    ['node .claude/hooks/verify.mjs --scope full', 'verify-full'],
    ['pnpm test:integration', 'test'],
    ['pnpm exec vitest run .claude/hooks', 'test'],
    ['pnpm lint', 'lint'],
    ['git status --short', 'git'],
    ['cd /repo && rg -n foo docs', 'search'],
    [`curl -H "Authorization: ${SENSITIVE}" https://x`, 'other'],
    [undefined, 'other'],
  ])('sorterar %s som %s', (command, category) => {
    expect(bashCategory(command)).toBe(category);
  });
});

describe('toolEntry', () => {
  it('skriver aldrig kommandotext, sökmönster, innehåll eller felmeddelanden', () => {
    const inputs = [
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: `export T=${SENSITIVE}`, description: SENSITIVE },
        tool_response: { stdout: SENSITIVE },
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: SENSITIVE, path: `/repo/${SENSITIVE}` },
        tool_response: SENSITIVE,
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/a.ts', content: SENSITIVE },
        tool_response: { content: SENSITIVE },
      },
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: SENSITIVE },
        error: SENSITIVE,
      },
    ];
    for (const input of inputs) {
      const line = JSON.stringify(toolEntry({ session_id: 's1', ...input }, REPO, NOW));
      expect(line).not.toContain(SENSITIVE);
    }
  });

  it('mäter svarets storlek och läsningens intervall', () => {
    const entry = toolEntry(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/docs/plan.md', offset: 10, limit: 5 },
        tool_response: 'abc',
      },
      REPO,
      NOW,
    );
    expect(entry).toMatchObject({
      tool: 'Read',
      outcome: 'ok',
      path: 'docs/plan.md',
      offset: 10,
      limit: 5,
      responseChars: 5,
    });
  });

  it.each([
    ['Read', { file_path: '~/hemligt/nyckel.txt' }],
    ['Edit', { file_path: '~/hemligt/nyckel.txt', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '~/hemligt/nyckel.txt', content: 'a' }],
    ['NotebookEdit', { notebook_path: '~/hemligt/nyckel.txt' }],
    ['Edit', { file_path: '$HOME/hemligt/nyckel.txt' }],
    ['Write', { file_path: '/Users/x/hemligt/nyckel.txt', content: 'a' }],
  ])('loggar aldrig en extern sökväg i klartext för %s %j', (toolName, toolInput) => {
    const entry = toolEntry(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: toolName,
        tool_input: toolInput,
      },
      REPO,
      NOW,
    );
    expect(entry.path).toMatch(/^hash:[0-9a-f]{16}$/);
    expect(JSON.stringify(entry)).not.toContain('hemligt');
  });

  it('skriver bara de godkända fälten', () => {
    const allowed = [
      'agent',
      'category',
      'event',
      'limit',
      'offset',
      'outcome',
      'path',
      'responseChars',
      'session',
      'tool',
      'ts',
    ];
    const entry = toolEntry(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Read',
        agent_type: 'reviewer',
        agent_id: 'a1',
        cwd: '/repo',
        transcript_path: '/t.jsonl',
        tool_use_id: 'x',
        duration_ms: 12,
        tool_input: { file_path: '/repo/a.md', offset: 1, limit: 2, extra: 'x' },
        tool_response: 'abc',
      },
      REPO,
      NOW,
    );
    expect(Object.keys(entry).filter((key) => !allowed.includes(key))).toEqual([]);
  });

  it('skiljer ett fel från ett avbrott', () => {
    const failure = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: {},
    };
    expect(toolEntry(failure, REPO, NOW).outcome).toBe('error');
    expect(toolEntry({ ...failure, is_interrupt: true }, REPO, NOW).outcome).toBe(
      'interrupted',
    );
  });

  it('släpper inte igenom oväntad text i namnfält', () => {
    const entry = toolEntry(
      {
        hook_event_name: 'PostToolUse',
        session_id: `s ${SENSITIVE}\n`,
        tool_name: 'x y',
        agent_type: 'a b',
      },
      REPO,
      NOW,
    );
    expect(entry).toMatchObject({ session: 'other', tool: 'other', agent: 'other' });
  });
});

describe('readUsage', () => {
  const transcript = (lines) => {
    const path = join(dir, 't.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };

  it('räknar varje svar en gång även om det står på flera rader', () => {
    const path = transcript([
      assistantLine('m1', USAGE),
      assistantLine('m1', USAGE),
      assistantLine('m2', USAGE),
    ]);
    expect(readUsage(path)).toEqual({
      status: 'ok',
      messages: 2,
      skipped: 0,
      tokens: {
        input_tokens: 4,
        output_tokens: 20,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 2000,
      },
    });
  });

  it('returnerar bara siffror, aldrig text ur transkriptet', () => {
    const path = transcript([assistantLine('m1', { ...USAGE, note: SENSITIVE })]);
    expect(JSON.stringify(readUsage(path))).not.toContain(SENSITIVE);
  });

  it('ignorerar text om usage från användaren och verktyg', () => {
    const user = JSON.stringify({ type: 'user', message: { usage: USAGE, id: 'u1' } });
    const path = transcript([user, assistantLine('m1', USAGE)]);
    expect(readUsage(path)).toMatchObject({ status: 'ok', messages: 1 });
  });

  it('räknar inte en trasig rad och markerar resultatet som partial', () => {
    const path = transcript([
      assistantLine('m1', USAGE),
      '{"usage": trasig',
      assistantLine('m2', { ...USAGE, output_tokens: 'många' }),
    ]);
    expect(readUsage(path)).toMatchObject({ status: 'partial', messages: 1, skipped: 2 });
  });

  it('redovisar varför tokens inte gick att mäta i stället för att uppskatta', () => {
    expect(readUsage(undefined)).toEqual({ status: 'unavailable', reason: 'no_transcript' });
    expect(readUsage(join(dir, 'saknas.jsonl'))).toEqual({
      status: 'unavailable',
      reason: 'unreadable',
    });
    expect(readUsage(transcript(['{"type":"user"}']))).toEqual({
      status: 'unavailable',
      reason: 'no_usage',
    });
  });

  it('läser inte ett orimligt stort transkript', () => {
    const path = join(dir, 'stort.jsonl');
    writeFileSync(path, '');
    truncateSync(path, 200 * 1024 * 1024 + 1);
    expect(readUsage(path)).toEqual({ status: 'unavailable', reason: 'too_large' });
  });
});

describe('entryFor', () => {
  it('mäter huvudsessionen vid SessionEnd och subagenten vid SubagentStop', () => {
    const path = join(dir, 't.jsonl');
    writeFileSync(path, `${assistantLine('m1', USAGE)}\n`);
    const end = { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: path };
    const stop = {
      hook_event_name: 'SubagentStop',
      session_id: 's1',
      agent_id: 'a1',
      transcript_path: join(dir, 'annan.jsonl'),
      agent_transcript_path: path,
    };
    expect(entryFor(end, REPO, NOW)).toMatchObject({
      event: 'usage',
      source: 'main',
      status: 'ok',
    });
    expect(entryFor(stop, REPO, NOW)).toMatchObject({ source: 'a1', status: 'ok' });
  });

  it('sparar subagentens typ på token-raden', () => {
    const input = { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'reviewer' };
    expect(entryFor(input, REPO, NOW)).toMatchObject({
      agent: 'reviewer',
      status: 'unavailable',
    });
  });

  it('mäter inte andra händelser', () => {
    expect(entryFor({ hook_event_name: 'PreToolUse' }, REPO, NOW)).toBeNull();
  });
});

describe('hooken som process', () => {
  // Kopierad till en tom katalog: mätfilen hamnar då där och aldrig i det riktiga .claude/metrics.
  const installed = () => {
    const hooks = join(dir, '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const file of ['metrics.mjs', 'guard-paths.mjs']) {
      copyFileSync(join(HOOKS, file), join(hooks, file));
    }
    return join(hooks, 'metrics.mjs');
  };
  const run = (script, input) => spawnSync('node', [script], { input, encoding: 'utf8' });

  it('skriver en rad och ingenting på stdout', () => {
    const script = installed();
    const result = run(
      script,
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: `echo ${SENSITIVE}` },
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const metrics = join(dir, '.claude', 'metrics');
    const [file] = readdirSync(metrics);
    const content = readFileSync(join(metrics, file), 'utf8');
    expect(JSON.parse(content)).toMatchObject({ tool: 'Bash', category: 'other' });
    expect(content).not.toContain(SENSITIVE);
  });

  it('slutar med exit 0 vid trasig indata', () => {
    const result = run(installed(), 'inte json');
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, '.claude', 'metrics'))).toBe(false);
  });

  it('slutar med exit 0 när mätkatalogen inte går att skapa', () => {
    const script = installed();
    writeFileSync(join(dir, '.claude', 'metrics'), 'en fil i vägen');
    const result = run(
      script,
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'x' }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('slutar med exit 0 och hashar alla sökvägar när spärrens mönster saknas', () => {
    const script = installed();
    rmSync(join(dirname(script), 'guard-paths.mjs'));
    const result = run(
      script,
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { file_path: join(dir, 'a.md') },
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const metrics = join(dir, '.claude', 'metrics');
    const [file] = readdirSync(metrics);
    expect(JSON.parse(readFileSync(join(metrics, file), 'utf8')).path).toMatch(/^hash:/);
  });

  it('kör även när skriptet startas via en symbolisk länk', () => {
    const script = installed();
    const link = join(dir, 'lank');
    symlinkSync(join(dir, '.claude'), link);
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'x' });
    expect(run(join(link, 'hooks', 'metrics.mjs'), input).status).toBe(0);
    expect(existsSync(join(dirname(dirname(script)), 'metrics'))).toBe(true);
  });
});

describe('analyzeSession', () => {
  it('hittar en omläsning av samma intervall utan ändring emellan', () => {
    const { rereads } = analyzeSession('s1', [read('a.md'), read('a.md'), read('a.md')]);
    expect(rereads).toEqual([['a.md', 2]]);
  });

  it('räknar onödiga läsningar, inte läsningar, över ändringar och agenter', () => {
    const reviewer = read('a.md', { agent: 'reviewer' });
    const aroundEdit = [read('a.md'), read('a.md'), edit('a.md'), read('a.md'), read('a.md')];
    const twoAgents = [read('a.md'), read('a.md'), reviewer, reviewer];
    expect(analyzeSession('s1', aroundEdit).rereads).toEqual([['a.md', 2]]);
    expect(analyzeSession('s1', twoAgents).rereads).toEqual([['a.md', 2]]);
  });

  it('räknar inte ett annat intervall, en ändring emellan eller en annan agent', () => {
    const entries = [
      read('a.md', { offset: 1, limit: 5 }),
      read('a.md', { offset: 6, limit: 5 }),
      read('b.md'),
      edit('b.md'),
      read('b.md'),
      read('c.md'),
      read('c.md', { agent: 'reviewer' }),
    ];
    expect(analyzeSession('s1', entries).rereads).toEqual([]);
  });

  it('räknar inte en läsning efter att en annan agent ändrat filen', () => {
    const entries = [
      read('a.ts', { agent: 'reviewer' }),
      edit('a.ts'),
      read('a.ts', { agent: 'reviewer' }),
    ];
    expect(analyzeSession('s1', entries).rereads).toEqual([]);
  });

  it('flaggar stora läsningar', () => {
    const entries = [
      read('a.md', { responseChars: 20_001 }),
      read('b.md', { responseChars: 20_000 }),
    ];
    expect(analyzeSession('s1', entries).largeReads).toEqual([['a.md', 20_001]]);
  });

  it('flaggar tre fel i följd men inte fel som bryts av ett lyckat anrop', () => {
    const fail = tool({ tool: 'Bash', category: 'test', outcome: 'error' });
    const pass = tool({ tool: 'Bash', category: 'test' });
    expect(analyzeSession('s1', [fail, fail, fail]).repeatedFailures).toEqual([
      ['Bash/test', 3],
    ]);
    expect(analyzeSession('s1', [fail, fail, pass, fail]).repeatedFailures).toEqual([]);
  });

  it('flaggar en /verify utan ändring sedan en godkänd körning', () => {
    expect(analyzeSession('s1', [verify(), verify()]).redundantVerifies).toBe(1);
    expect(analyzeSession('s1', [verify(), edit('a.ts'), verify()]).redundantVerifies).toBe(0);
    expect(analyzeSession('s1', [verify('error'), verify()]).redundantVerifies).toBe(0);
  });

  it('räknar inte en full körning som dubblett av en vanlig, men tvärtom', () => {
    const full = tool({ tool: 'Bash', category: 'verify-full' });
    expect(analyzeSession('s1', [verify(), full]).redundantVerifies).toBe(0);
    expect(analyzeSession('s1', [full, verify()]).redundantVerifies).toBe(1);
  });

  it('använder senaste token-raden per källa och markerar saknade subagenter', () => {
    const usage = (source, input) => ({
      ts: '2026-11-07T12:00:00.000Z',
      event: 'usage',
      session: 's1',
      source,
      status: 'ok',
      tokens: { ...USAGE, input_tokens: input },
    });
    const subagentCall = tool({ tool: 'Agent' });
    const { usage: result } = analyzeSession('s1', [
      usage('main', 1),
      usage('main', 5),
      usage('a1', 2),
      subagentCall,
      subagentCall,
    ]);
    expect(result).toMatchObject({
      hasMain: true,
      isPartial: true,
      measuredSubagents: 1,
      subagents: 2,
    });
    expect(result.totals.input).toBe(7);
  });

  it('räknar en subagent som startats via Skill från agenttypen i loggen', () => {
    const { usage } = analyzeSession('s1', [
      tool({ tool: 'Skill' }),
      read('a.md', { agent: 'reviewer' }),
    ]);
    expect(usage).toMatchObject({ subagents: 1, measuredSubagents: 0, isPartial: true });
  });

  it('håller rader utan transkript utanför fullständighetskontrollen', () => {
    const row = (source, fields) => ({
      ts: NOW.toISOString(),
      event: 'usage',
      session: 's1',
      source,
      ...fields,
    });
    const { usage } = analyzeSession('s1', [
      row('main', { status: 'ok', tokens: USAGE }),
      row('a1', { status: 'ok', tokens: USAGE }),
      row('a2', { status: 'unavailable', reason: 'unreadable' }),
      read('a.md', { agent: 'reviewer' }),
    ]);
    expect(usage).toMatchObject({
      isPartial: false,
      subagents: 1,
      measuredSubagents: 1,
      withoutTranscript: 1,
    });
  });
});

describe('rapporten', () => {
  it('klarar att mätkatalogen saknas', () => {
    const loaded = loadEntries(join(dir, 'saknas'));
    expect(loaded).toEqual({ entries: [], badLines: 0 });
    expect(formatReport(loaded)).toContain('Ingen mätdata');
  });

  it('hoppar över trasiga rader och visar att de fanns', () => {
    writeFileSync(
      join(dir, 'tools-2026-11.jsonl'),
      `${JSON.stringify(read('a.md'))}\ntrasig\n{"ts":1}\n\n`,
    );
    writeFileSync(join(dir, 'annat.jsonl'), 'ignoreras\n');
    const loaded = loadEntries(dir);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.badLines).toBe(2);
    expect(formatReport(loaded)).toContain('Trasiga rader som hoppades över: 2.');
  });

  it('räknar rader med giltig JSON men fel form som trasiga', () => {
    const usage = { ts: 't', event: 'usage', session: 's1', source: 'main' };
    const rows = [
      { ...usage, tokens: null },
      { ...usage, tokens: {} },
      { ts: 't', event: 'tool', session: 's1' },
      { ts: 't', event: 'annat', session: 's1' },
      tool({ tool: 'Bash', category: 1 }),
      tool({ tool: 'Bash', category: 2 }),
      read('a.md', { agent: 7 }),
      read(9),
    ];
    writeFileSync(
      join(dir, 'tools-2026-11.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    const loaded = loadEntries(dir);
    expect(loaded).toEqual({ entries: [], badLines: 8 });
    expect(formatReport(loaded)).toContain('Ingen mätdata');
  });

  describe('tokenraden', () => {
    const usageRow = (source, fields) => ({
      ts: NOW.toISOString(),
      event: 'usage',
      session: 's1',
      source,
      status: 'ok',
      tokens: USAGE,
      ...fields,
    });
    const reportFor = (entries) => formatReport({ entries, badLines: 0 });
    const reviewerRead = read('a.md', { agent: 'reviewer' });

    it('summerar uppmätta värden för huvudsessionen och subagenten', () => {
      const report = reportFor([usageRow('main'), usageRow('a1'), reviewerRead]);
      expect(report).toContain(
        'Tokens: in 4, ut 20, cache skriv 200, cache läs 2000 (huvudsession + 1 av 1 subagenter)',
      );
      expect(report).toContain('Tokens mätta i 1 av 1 sessioner.');
      expect(report).not.toContain('OFULLSTÄNDIG');
    });

    it('markerar OFULLSTÄNDIG när en känd subagent saknar tokens', () => {
      expect(reportFor([usageRow('main'), reviewerRead])).toContain(
        'Tokens: in 2, ut 10, cache skriv 100, cache läs 1000 (huvudsession + 0 av 1 subagenter, OFULLSTÄNDIG)',
      );
    });

    it('markerar OFULLSTÄNDIG när transkriptet hade rader som inte gick att tolka', () => {
      expect(reportFor([usageRow('main', { status: 'partial' })])).toContain('OFULLSTÄNDIG');
    });
  });

  describe('gränsen på fem sessioner', () => {
    const sessions = (count) =>
      Array.from({ length: count }, (_, i) =>
        read('a.md', { session: `s${i + 1}`, ts: `2026-11-0${i + 1}T12:00:00.000Z` }),
      );

    it('visar de fem senaste, nyast först, och säger att fler finns', () => {
      const report = formatReport({ entries: sessions(6), badLines: 0 });
      const shown = report.match(/^Session s\d/gm);
      expect(shown).toEqual([
        'Session s6',
        'Session s5',
        'Session s4',
        'Session s3',
        'Session s2',
      ]);
      expect(report).toContain('Totalt: 6 sessioner, 6 anrop.');
      expect(report).toContain('Visar de 5 senaste sessionerna.');
    });

    it('nämner ingen gräns när alla sessioner får plats', () => {
      const report = formatReport({ entries: sessions(5), badLines: 0 });
      expect(report.match(/^Session s\d/gm)).toHaveLength(5);
      expect(report).not.toContain('senaste sessionerna');
    });
  });

  it('visar fynden per session', () => {
    const fail = tool({ tool: 'Bash', category: 'test', outcome: 'error' });
    const report = formatReport({
      entries: [
        read('a.md', { responseChars: 30_000 }),
        read('a.md', { responseChars: 30_000 }),
        fail,
        fail,
        fail,
        verify(),
        verify(),
        {
          ts: NOW.toISOString(),
          event: 'usage',
          session: 's1',
          source: 'a1',
          status: 'unavailable',
          reason: 'unreadable',
        },
      ],
      badLines: 0,
    });
    expect(report).toContain('Verktyg: Bash 5, Read 2');
    expect(report).toContain('Bash: test 3, verify 2');
    expect(report).toContain('Omläsningar: a.md ×1');
    expect(report).toContain('Stora läsningar (tecken): a.md 30000, a.md 30000');
    expect(report).toContain('Upprepade fel: Bash/test ×3');
    expect(report).toContain('Onödig /verify: 1');
    expect(report).toContain('Subagentrader utan transkript: 1 (räknas inte med)');
  });

  it('skriver ej mätt när tokens saknas, utan någon uppskattning', () => {
    const report = formatReport({ entries: [read('a.md')], badLines: 0 });
    expect(report).toContain('Tokens: ej mätt (ingen sessionsrad)');
    expect(report).toContain('Tokens mätta i 0 av 1 sessioner.');
  });

  it('visar orsaken när transkriptet inte gick att läsa', () => {
    const entry = {
      ts: NOW.toISOString(),
      event: 'usage',
      session: 's1',
      source: 'main',
      status: 'unavailable',
      reason: 'unreadable',
    };
    expect(formatReport({ entries: [entry], badLines: 0 })).toContain('ej mätt (unreadable)');
  });
});
