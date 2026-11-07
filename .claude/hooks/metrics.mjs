/**
 * Lokal mätning av Claude Code-arbetsflödet (ADR-0012): en JSON-rad per verktygsanrop och en rad med
 * tokenanvändning när en session eller subagent slutar. Raderna hamnar i `.claude/metrics/`, som är
 * gitignorerad, och läses av metrics-report.mjs.
 *
 * Fallgrop: varje fält skrivs uttryckligen. Kommandotext, sökmönster, filinnehåll, felmeddelanden och
 * transkripttext får aldrig kopieras hit, därför sprids aldrig `tool_input` eller `tool_response`. En
 * sökväg sparas i klartext bara om den ligger i repot och inte ser ut som en hemlig fil; alla andra
 * hashas med sessions-id som nyckel, vilket räcker för att känna igen en omläsning i samma session.
 * Nyckeln står i loggen, så hashen döljer sökvägen vid en vanlig läsning men inte mot den som gissar.
 * Mätningen får aldrig stoppa arbetet: alla fel sväljs och skriptet slutar alltid med exit 0. Därför
 * laddas spärrens hemlighetsmönster dynamiskt; saknas det hashas varje sökväg.
 */
import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_PATH = await import('./guard-paths.mjs').then(
  (module) => module.SECRET_PATH,
  () => undefined,
);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_PATH_LENGTH = 300;
const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
const BASH_CATEGORIES = [
  ['verify-full', /^node\s+\S*\.claude\/hooks\/verify\.mjs\s+--scope\s+full(\s|$)/],
  ['verify', /^node\s+\S*\.claude\/hooks\/verify\.mjs(\s|$)/],
  ['test', /^(pnpm\s+(exec\s+)?(test|vitest)|npx\s+vitest|vitest)\b/],
  [
    'lint',
    /^(pnpm\s+(exec\s+)?(lint|typecheck|format|eslint|prettier|tsc)|eslint|prettier|tsc)\b/,
  ],
  ['git', /^(git|gh)\b/],
  ['search', /^(rg|grep|find|ls|cat|head|tail|sed|wc)\b/],
];

export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);
export const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

export const metricsDir = (repo) => join(repo, '.claude', 'metrics');

const safeName = (value) =>
  typeof value === 'string' && /^[\w:.-]{1,100}$/.test(value) ? value : 'other';
const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Sökvägen relativt repot, eller en hash om den ligger utanför, är ovanligt lång eller ser hemlig ut.
 * Bara en absolut sökväg kan bevisas ligga i repot: `~/x` och `$HOME/x` pekar utanför men skulle tolkas
 * som filer i repot om de löstes upp härifrån, så allt som inte är absolut hashas.
 */
export function safePath(path, repo, salt) {
  if (typeof path !== 'string' || path === '') return undefined;
  const inRepo = isAbsolute(path) ? relative(repo, path) : '';
  const isInside = inRepo !== '' && !inRepo.startsWith('..');
  const isClean = SECRET_PATH instanceof RegExp && !SECRET_PATH.test(inRepo);
  if (isInside && isClean && inRepo.length <= MAX_PATH_LENGTH) return inRepo;
  return `hash:${createHmac('sha256', salt).update(path).digest('hex').slice(0, 16)}`;
}

/** En fast kategori för ett Bash-kommando. Själva kommandot lämnar aldrig den här funktionen. */
export function bashCategory(command) {
  if (typeof command !== 'string') return 'other';
  const start = command.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  return BASH_CATEGORIES.find(([, pattern]) => pattern.test(start))?.[0] ?? 'other';
}

function outcomeOf(input) {
  if (input.hook_event_name !== 'PostToolUseFailure') return 'ok';
  return input.is_interrupt === true ? 'interrupted' : 'error';
}

/** Det serialiserade svarets längd. Metadata och escape-tecken ingår, så måttet är inte filens storlek. */
function responseChars(response) {
  try {
    return JSON.stringify(response ?? '').length;
  } catch {
    return undefined;
  }
}

export function toolEntry(input, repo, now) {
  const toolInput = input.tool_input ?? {};
  const entry = {
    ts: now.toISOString(),
    event: 'tool',
    session: safeName(input.session_id),
    tool: safeName(input.tool_name),
    outcome: outcomeOf(input),
  };
  if (input.agent_type !== undefined) entry.agent = safeName(input.agent_type);
  if (input.hook_event_name === 'PostToolUse') {
    entry.responseChars = responseChars(input.tool_response);
  }
  if (input.tool_name === 'Bash') entry.category = bashCategory(toolInput.command);
  if (FILE_TOOLS.has(input.tool_name)) {
    const path = toolInput.file_path ?? toolInput.notebook_path;
    entry.path = safePath(path, repo, String(input.session_id));
  }
  if (input.tool_name === 'Read') {
    if (isCount(toolInput.offset)) entry.offset = toolInput.offset;
    if (isCount(toolInput.limit)) entry.limit = toolInput.limit;
  }
  return entry;
}

function usageFrom(line) {
  const parsed = JSON.parse(line);
  if (parsed?.type !== 'assistant' || parsed.message?.usage === undefined) return null;
  const { id, usage } = parsed.message;
  const numbers = USAGE_FIELDS.map((field) => usage[field]);
  if (typeof id !== 'string' || !numbers.every(isCount)) throw new Error('ofullständig usage');
  return { id, numbers };
}

/**
 * Summerar de numeriska `usage`-fälten i ett transkript. Samma svar står på flera rader med samma
 * `usage` (en rad per innehållsblock), så varje `message.id` räknas en gång. Rader som inte går att
 * tolka räknas inte med och gör resultatet `partial`; något uppskattat värde finns aldrig.
 */
export function readUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string')
    return { status: 'unavailable', reason: 'no_transcript' };
  let text;
  try {
    if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) {
      return { status: 'unavailable', reason: 'too_large' };
    }
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { status: 'unavailable', reason: 'unreadable' };
  }
  const perMessage = new Map();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const usage = usageFrom(line);
      if (usage !== null) perMessage.set(usage.id, usage.numbers);
    } catch {
      skipped += 1;
    }
  }
  if (perMessage.size === 0) return { status: 'unavailable', reason: 'no_usage' };
  const tokens = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  for (const numbers of perMessage.values()) {
    USAGE_FIELDS.forEach((field, i) => {
      tokens[field] += numbers[i];
    });
  }
  return {
    status: skipped === 0 ? 'ok' : 'partial',
    messages: perMessage.size,
    skipped,
    tokens,
  };
}

function usageEntry(input, transcriptPath, source, now) {
  return {
    ts: now.toISOString(),
    event: 'usage',
    session: safeName(input.session_id),
    source,
    ...(input.agent_type === undefined ? {} : { agent: safeName(input.agent_type) }),
    ...readUsage(transcriptPath),
  };
}

/** Raden för en hook-händelse, eller `null` om händelsen inte mäts. */
export function entryFor(input, repo, now) {
  switch (input.hook_event_name) {
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return toolEntry(input, repo, now);
    case 'SessionEnd':
      return usageEntry(input, input.transcript_path, 'main', now);
    case 'SubagentStop':
      return usageEntry(input, input.agent_transcript_path, safeName(input.agent_id), now);
    default:
      return null;
  }
}

export function appendEntry(repo, entry) {
  const dir = metricsDir(repo);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `tools-${entry.ts.slice(0, 7)}.jsonl`);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Om modulen körs direkt. Sökvägarna jämförs upplösta: `argv[1]` kan gå via en symbolisk länk (`/tmp` på
 * macOS), `import.meta.url` gör det aldrig, och en direkt jämförelse skulle tyst hoppa över hela skriptet.
 */
export function isEntryPoint(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

function main() {
  try {
    const entry = entryFor(JSON.parse(readFileSync(0, 'utf8')), REPO, new Date());
    if (entry !== null) appendEntry(REPO, entry);
  } catch {
    // En rad som inte blev skriven är bara en lucka i mätningen och får aldrig störa arbetet.
    process.exitCode = 0;
  }
}

if (isEntryPoint(import.meta.url)) main();
