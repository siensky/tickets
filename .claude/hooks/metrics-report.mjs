/**
 * Rapporten över den lokala mätningen (metrics.mjs, ADR-0012): `node .claude/hooks/metrics-report.mjs`.
 * Visar verktygsanvändning och tokens per session och pekar ut det som kan vara onödigt arbete.
 *
 * Fallgrop: fynden är signaler, inte bevis. En omläsning kan vara motiverad, filer som ändrats via Bash
 * syns inte som ändringar, och spärrade anrop når inte mätningen. Tokens som inte kunde läsas visas som
 * "ej mätt" och uppskattas aldrig. Agenter skiljs på typ, inte instans, så två omgångar av samma
 * subagent räknas som en läsare. `/review` startas som Skill, därför räknas subagenter även från
 * agenttyperna i loggen. Skriptet skriver ingenting och tar inga argument.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_TOOLS, USAGE_FIELDS, isEntryPoint, metricsDir } from './metrics.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOWN_SESSIONS = 5;
const LARGE_READ_CHARS = 20_000;
const REPEATED_FAILURES = 3;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

const VERIFY_CATEGORIES = new Set(['verify', 'verify-full']);

const isVerify = (entry) => entry.tool === 'Bash' && VERIFY_CATEGORIES.has(entry.category);

const hasValidTokens = ({ tokens }) =>
  tokens === undefined ||
  (tokens !== null && USAGE_FIELDS.every((field) => Number.isFinite(tokens[field])));

const isOptionalText = (value) => value === undefined || typeof value === 'string';

function isValidEntry(entry) {
  if (typeof entry?.ts !== 'string' || typeof entry.session !== 'string') return false;
  if (entry.event === 'tool') {
    return (
      typeof entry.tool === 'string' &&
      typeof entry.outcome === 'string' &&
      [entry.category, entry.agent, entry.path].every(isOptionalText)
    );
  }
  return entry.event === 'usage' && typeof entry.source === 'string' && hasValidTokens(entry);
}

/** Alla rader i mätfilerna. Rader som är trasiga eller har fel form räknas men hoppas över. */
export function loadEntries(dir) {
  if (!existsSync(dir)) return { entries: [], badLines: 0 };
  const entries = [];
  let badLines = 0;
  const files = readdirSync(dir).filter((name) => /^tools-.*\.jsonl$/.test(name));
  for (const name of files.sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        const entry = JSON.parse(line);
        if (!isValidEntry(entry)) throw new Error('okänd rad');
        entries.push(entry);
      } catch {
        badLines += 1;
      }
    }
  }
  return { entries, badLines };
}

function countBy(entries, keyOf) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

/**
 * Filer som samma agenttyp läst igen, med samma intervall, och hur många läsningar som var onödiga
 * (`×N` i rapporten; den första läsningen räknas inte). En ändring av filen nollställer alla agenters
 * läsningar: efter den är en ny läsning nödvändig, oavsett vem som ändrade.
 */
function findRereads(tools) {
  const seenByPath = new Map();
  const rereads = new Map();
  for (const entry of tools) {
    if (entry.path === undefined || entry.outcome !== 'ok') continue;
    if (entry.tool !== 'Read') {
      seenByPath.delete(entry.path);
      continue;
    }
    const seen = seenByPath.get(entry.path) ?? new Set();
    const key = `${entry.agent ?? 'main'}\0${entry.offset ?? ''}\0${entry.limit ?? ''}`;
    if (seen.has(key)) rereads.set(entry.path, (rereads.get(entry.path) ?? 0) + 1);
    seenByPath.set(entry.path, seen.add(key));
  }
  return [...rereads];
}

/** Längsta följd av fel per verktyg och kategori, för följder som nått gränsen. */
function findRepeatedFailures(tools) {
  const current = new Map();
  const longest = new Map();
  for (const entry of tools) {
    const key = entry.category === undefined ? entry.tool : `${entry.tool}/${entry.category}`;
    const streak = entry.outcome === 'error' ? (current.get(key) ?? 0) + 1 : 0;
    current.set(key, streak);
    if (streak >= REPEATED_FAILURES) longest.set(key, Math.max(longest.get(key) ?? 0, streak));
  }
  return [...longest];
}

/**
 * Verifieringar utan filändring sedan en godkänd körning av samma slag. En `full` kör fler steg, så den
 * räknas aldrig som dubblett av en vanlig körning, men en vanlig körning efter en godkänd `full` gör det.
 */
function countRedundantVerifies(tools) {
  const clean = new Set();
  let redundant = 0;
  for (const entry of tools) {
    if (FILE_TOOLS.has(entry.tool) && entry.tool !== 'Read' && entry.outcome === 'ok') {
      clean.clear();
    } else if (isVerify(entry)) {
      if (clean.has(entry.category) || clean.has('verify-full')) redundant += 1;
      if (entry.outcome === 'ok') clean.add(entry.category);
      else clean.clear();
    }
  }
  return redundant;
}

/**
 * Senaste raden per källa: en återupptagen session skriver om sin summa i stället för att lägga till.
 * Subagentrader utan transkript redovisas för sig. Vad de är vet vi inte, och de ska varken räknas som
 * subagenter eller göra en annars fullständig mätning ofullständig; `knownSubagents` avslöjar en verklig
 * subagent som saknar tokens.
 */
function summarizeUsage(usageEntries, knownSubagents) {
  const latest = new Map(usageEntries.map((entry) => [entry.source, entry]));
  const rows = [...latest.values()];
  const measured = rows.filter((entry) => entry.tokens !== undefined);
  const main = latest.get('main');
  const measuredSubagents = measured.filter((entry) => entry.source !== 'main').length;
  const subagents = Math.max(knownSubagents, measuredSubagents);
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const { tokens } of measured) {
    totals.input += tokens.input_tokens;
    totals.output += tokens.output_tokens;
    totals.cacheWrite += tokens.cache_creation_input_tokens;
    totals.cacheRead += tokens.cache_read_input_tokens;
  }
  return {
    hasMain: main?.tokens !== undefined,
    reason: main?.reason ?? 'ingen sessionsrad',
    isPartial:
      measured.some((entry) => entry.status === 'partial') || measuredSubagents < subagents,
    measuredSubagents,
    subagents,
    withoutTranscript: rows.filter(
      (entry) => entry.source !== 'main' && entry.tokens === undefined,
    ).length,
    totals,
  };
}

export function analyzeSession(session, entries) {
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  const tools = sorted.filter((entry) => entry.event === 'tool');
  const subagentCalls = tools.filter((entry) => SUBAGENT_TOOLS.has(entry.tool)).length;
  const agentTypes = new Set(tools.flatMap((entry) => entry.agent ?? []));
  return {
    session,
    start: sorted[0]?.ts ?? '',
    calls: tools.length,
    failures: tools.filter((entry) => entry.outcome === 'error').length,
    byTool: countBy(tools, (entry) => entry.tool),
    byCategory: countBy(
      tools.filter((entry) => entry.category !== undefined),
      (entry) => entry.category,
    ),
    rereads: findRereads(tools),
    largeReads: tools
      .filter((entry) => entry.tool === 'Read' && entry.responseChars > LARGE_READ_CHARS)
      .map((entry) => [entry.path ?? 'okänd', entry.responseChars]),
    repeatedFailures: findRepeatedFailures(tools),
    redundantVerifies: countRedundantVerifies(tools),
    usage: summarizeUsage(
      sorted.filter((entry) => entry.event === 'usage'),
      Math.max(subagentCalls, agentTypes.size),
    ),
  };
}

const pairs = (list, separator = ' ') =>
  list.map(([name, value]) => `${name}${separator}${value}`).join(', ');

function formatUsage({ hasMain, reason, isPartial, measuredSubagents, subagents, totals }) {
  if (!hasMain) return `ej mätt (${reason})`;
  const { input, output, cacheWrite, cacheRead } = totals;
  const scope = `huvudsession + ${measuredSubagents} av ${subagents} subagenter`;
  const partial = isPartial ? ', OFULLSTÄNDIG' : '';
  return `in ${input}, ut ${output}, cache skriv ${cacheWrite}, cache läs ${cacheRead} (${scope}${partial})`;
}

function formatSession(analysis) {
  const lines = [
    `Session ${analysis.session.slice(0, 8)} (${analysis.start.slice(0, 16)}): ${analysis.calls} anrop, ${analysis.failures} fel, ${analysis.usage.subagents} subagenter`,
    `  Verktyg: ${pairs(analysis.byTool) || '–'}`,
    `  Bash: ${pairs(analysis.byCategory) || '–'}`,
    `  Tokens: ${formatUsage(analysis.usage)}`,
  ];
  if (analysis.usage.withoutTranscript > 0) {
    lines.push(
      `  Subagentrader utan transkript: ${analysis.usage.withoutTranscript} (räknas inte med)`,
    );
  }
  if (analysis.rereads.length > 0) {
    lines.push(`  Omläsningar: ${pairs(analysis.rereads, ' ×')}`);
  }
  if (analysis.largeReads.length > 0) {
    lines.push(`  Stora läsningar (tecken): ${pairs(analysis.largeReads)}`);
  }
  if (analysis.repeatedFailures.length > 0) {
    lines.push(`  Upprepade fel: ${pairs(analysis.repeatedFailures, ' ×')}`);
  }
  if (analysis.redundantVerifies > 0) {
    lines.push(`  Onödig /verify: ${analysis.redundantVerifies}`);
  }
  return lines.join('\n');
}

export function formatReport({ entries, badLines }) {
  if (entries.length === 0) return 'Ingen mätdata ännu (.claude/metrics/).';
  const sessions = new Map();
  for (const entry of entries) {
    sessions.set(entry.session, [...(sessions.get(entry.session) ?? []), entry]);
  }
  const analyses = [...sessions]
    .map(([session, rows]) => analyzeSession(session, rows))
    .sort((a, b) => b.start.localeCompare(a.start));
  const measured = analyses.filter((analysis) => analysis.usage.hasMain).length;
  const calls = analyses.reduce((sum, analysis) => sum + analysis.calls, 0);
  const lines = [
    'Claude Code-mätning (lokal). Fynden är signaler, inte bevis.',
    `Totalt: ${analyses.length} sessioner, ${calls} anrop. Tokens mätta i ${measured} av ${analyses.length} sessioner.`,
    ...analyses.slice(0, SHOWN_SESSIONS).map(formatSession),
    'Syns inte: spärrade anrop och filer som ändrats via Bash.',
  ];
  if (analyses.length > SHOWN_SESSIONS)
    lines.push(`Visar de ${SHOWN_SESSIONS} senaste sessionerna.`);
  if (badLines > 0) lines.push(`Trasiga rader som hoppades över: ${badLines}.`);
  return lines.join('\n');
}

if (isEntryPoint(import.meta.url)) {
  process.stdout.write(`${formatReport(loadEntries(metricsDir(REPO)))}\n`);
}
