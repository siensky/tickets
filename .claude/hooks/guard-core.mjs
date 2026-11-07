/**
 * PreToolUse-hook för Bash och Monitor (ADR-0012, rules.md §12). Andra lagret efter neka-reglerna i
 * .claude/settings.json: fångar kommandovägar som reglerna inte ser, som `git -C . commit`,
 * `sh -c '…'`, `$(…)`, `pnpm exec git …`, `find -exec`, git-alias, `GIT_PAGER=…` och `node -e` eller
 * `python -c` som nämner git eller en hemlig fil. Vad som nekas per program står i guard-rules.mjs,
 * sökvägar och miljövariabler i guard-paths.mjs.
 *
 * Fallgrop: spärren läser kommandotexten. Ett skript som bygger ihop kommandot när det körs går inte
 * att bedöma; det blir en vanlig fråga till användaren eftersom tolkarna aldrig är tillåtna. Den här
 * filen är logiken; ingången är guard.mjs, som blockerar (exit 2) om den här filen eller något den
 * importerar inte går att läsa in.
 */
import { basename } from 'node:path';
import {
  entersClaudeDir,
  isClaudeDir,
  isRiskyAssignment,
  mentionsSecret,
  touchesClaudeConfig,
  touchesClaudeState,
} from './guard-paths.mjs';
import {
  ASK_USER,
  CONFIG_NON_WRITERS,
  DIR_WRITERS,
  PROGRAM_CHECKS,
  SHELL_KEYWORDS,
  SHELLS,
  STATE_READERS,
  WRAPPERS,
  checkInlineCode,
  denyConfigWrite,
  denyStateWrite,
  deny,
  interpreterOf,
  skipOptions,
  strongest,
  wrappedByRunner,
  wrapperTarget,
} from './guard-rules.mjs';
import { splitCommands } from './shell-words.mjs';

const MAX_DEPTH = 6;
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_WRITES = /^-(delete|fprint0?|fprintf|fls)$/;
const DECLARES = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
const STDIN_SCRIPT = new Set(['-', '/dev/stdin', '/dev/fd/0']);

function checkShell(args, command, depth) {
  const scriptFlag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
  if (scriptFlag !== -1) {
    const script = args[scriptFlag + 1];
    if (script === undefined || script.dynamic) {
      return deny('shell-dynamic', 'Skriptet till skalet avgörs först när det körs.');
    }
    return evaluateCommand(script.text, depth + 1);
  }
  if (command.heredocs.length > 0) {
    return strongest(command.heredocs.map((body) => evaluateCommand(body, depth + 1)));
  }
  // `bash scripts/x.sh …`: skriptfilen bedöms som programmet (till exempel loadtest-mode.sh).
  const file = skipOptions(args, new Set(['-o', '+o']));
  if (file.length > 0 && !STDIN_SCRIPT.has(file[0].text))
    return evaluateWords(file, command, depth + 1);
  return deny('shell-stdin', 'Ett skal som läser sitt skript från stdin går inte att bedöma.');
}

function checkInterpreter(interpreter, args, command, options) {
  if (options.appendsArgs)
    return deny('stdin-args', 'Kod som läggs till från stdin går inte att bedöma.');
  const codes = interpreter.codes(args);
  if (codes.length > 0) return strongest(codes.map((code) => checkInlineCode(code)));
  if (command.heredocs.length > 0)
    return strongest(command.heredocs.map((body) => checkInlineCode(body)));
  if (interpreter.isInfoOnly(args)) return null;
  const script = skipOptions(args, new Set())[0];
  if (script !== undefined && !STDIN_SCRIPT.has(script.text)) return null;
  return deny('interpreter-stdin', 'Kod som läses från stdin går inte att bedöma.');
}

/** `find … -exec cmd {} ;`: varje kommando som find kör bedöms för sig, med argument som läggs till. */
function checkFind(args, command, depth) {
  const writes = args.some((a) => FIND_WRITES.test(a.text));
  if (writes && args.some((a) => touchesClaudeState(a) || isClaudeDir(a)))
    return denyStateWrite();
  const results = [];
  for (let i = 0; i < args.length; i += 1) {
    if (!FIND_EXEC.has(args[i].text)) continue;
    const end = args.findIndex((a, j) => j > i && (a.text === ';' || a.text === '+'));
    const segment = args.slice(i + 1, end === -1 ? args.length : end);
    results.push(evaluateWords(segment, command, depth + 1, { appendsArgs: true }));
  }
  return strongest(results);
}

const denyRiskyEnv = (word) =>
  deny(
    'env-override',
    `${word.text.split('=')[0]} kan få ett annat program att köras. ${ASK_USER}`,
  );

/** Under `xargs`/`find -exec` läggs argument till när kommandot körs; ett program utan underkommando kan då bli vad som helst. */
function checkAppendedArgs(program, args) {
  if (!(program in PROGRAM_CHECKS)) return null;
  // För git: argumentet från stdin behandlas som okänt, så ett saknat underkommando nekas.
  if (program === 'git')
    return PROGRAM_CHECKS.git([...args, { text: '<stdin>', dynamic: true }]);
  return deny(
    'stdin-args',
    `${program} med argument från stdin går inte att bedöma. ${ASK_USER}`,
  );
}

function checkPaths(program, args) {
  if (['cd', 'pushd'].includes(program) && args.some((a) => entersClaudeDir(a))) {
    return deny('claude-dir', 'Kör kommandon från projektroten, inte inifrån .claude/.');
  }
  if (DIR_WRITERS.has(program) && args.some((a) => isClaudeDir(a))) return denyStateWrite();
  // git räknas som läsande när underkommandot bara läser (git:s egen kontroll ger då inget beslut);
  // find bedöms av checkFind.
  const isReader =
    STATE_READERS.has(program) ||
    program === 'find' ||
    (program === 'git' && PROGRAM_CHECKS.git(args) === null);
  if (!isReader && args.some((a) => touchesClaudeState(a))) return denyStateWrite();
  if (
    !isReader &&
    !CONFIG_NON_WRITERS.has(program) &&
    args.some((a) => touchesClaudeConfig(a))
  )
    return denyConfigWrite();
  return null;
}

function checkDeclaration(program, args) {
  if (program === 'alias') {
    return args.some((a) => a.text.includes('='))
      ? deny('alias', `Ett alias kan byta ut vad ett kommando gör. ${ASK_USER}`)
      : null;
  }
  if (args.some((a) => touchesClaudeState(a))) return denyStateWrite();
  const risky = args.find((a) => isRiskyAssignment(a.text));
  return risky === undefined ? null : denyRiskyEnv(risky);
}

function evaluateProgram(program, args, command, depth, options) {
  const inner = { appendsArgs: options.appendsArgs || program === 'xargs' };
  if (SHELL_KEYWORDS.has(program)) return evaluateWords(args, command, depth + 1, options);
  if (program === 'function') return evaluateWords(args.slice(1), command, depth + 1, options);
  if (DECLARES.has(program) || program === 'alias') return checkDeclaration(program, args);
  if (WRAPPERS.has(program)) {
    const target = wrapperTarget(program, args);
    if (target.script !== undefined) return evaluateCommand(target.script, depth + 1);
    const risky = target.assignments.find((a) => isRiskyAssignment(a.text));
    if (risky !== undefined) return denyRiskyEnv(risky);
    return evaluateWords(target.words, command, depth + 1, inner);
  }
  const runner = wrappedByRunner(program, args);
  if (runner?.script !== undefined) return evaluateCommand(runner.script, depth + 1);
  if (runner !== null) return evaluateWords(runner.words, command, depth + 1, options);
  if (program === 'eval') return evaluateCommand(args.map((a) => a.text).join(' '), depth + 1);
  if (program.endsWith('loadtest-mode.sh')) {
    return deny('loadtest-mode', `Lasttestläget ändrar produktionen. ${ASK_USER}`);
  }
  const pathDecision = checkPaths(program, args);
  if (pathDecision !== null) return pathDecision;
  if (program === 'find') return checkFind(args, command, depth);
  if (SHELLS.has(program)) return checkShell(args, command, depth);
  const interpreter = interpreterOf(program);
  if (interpreter !== null) return checkInterpreter(interpreter, args, command, options);
  if (options.appendsArgs) return checkAppendedArgs(program, args);
  return PROGRAM_CHECKS[program]?.(args) ?? null;
}

function evaluateWords(words, command, depth, options = {}) {
  if (depth > MAX_DEPTH)
    return deny('too-deep', 'Kommandot är för djupt nästlat för att bedömas.');
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i += 1;
  const assignments = words.slice(0, i);
  if (assignments.some((a) => touchesClaudeState(a))) return denyStateWrite();
  const risky = assignments.find((a) => isRiskyAssignment(a.text));
  if (risky !== undefined) return denyRiskyEnv(risky);
  const [programWord, ...args] = words.slice(i);
  if (programWord === undefined) return null;
  if (programWord.dynamic)
    return deny('dynamic-program', 'Programnamnet avgörs först när kommandot körs.');
  return evaluateProgram(basename(programWord.text), args, command, depth, options);
}

function evaluateSimple(command, depth) {
  if (command.redirects.some((r) => touchesClaudeState(r) || isClaudeDir(r)))
    return denyStateWrite();
  if (command.redirects.some((r) => touchesClaudeConfig(r))) return denyConfigWrite();
  if ([...command.words, ...command.redirects].some((w) => mentionsSecret(w))) {
    return deny(
      'secret-path',
      'Kommandot rör en fil med hemligheter (.env, tfstate, kubeconfig).',
    );
  }
  return evaluateWords(command.words, command, depth);
}

/** Beslutet för en hel kommandorad: `{ decision, rule, reason }`, eller `null` om spärren inte har något att invända. */
export function evaluateCommand(src, depth = 0) {
  if (depth > MAX_DEPTH)
    return deny('too-deep', 'Kommandot är för djupt nästlat för att bedömas.');
  return strongest(splitCommands(src).map((command) => evaluateSimple(command, depth)));
}

function hookOutput(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** Hookens svar till Claude Code för en PreToolUse-händelse, eller `null` för "inget beslut". */
export function decide(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;
  let result;
  try {
    result = evaluateCommand(command);
  } catch (error) {
    result = deny(
      'unparseable',
      `Spärren kunde inte tolka kommandot (${error.message}). Skriv det enklare.`,
    );
  }
  return result === null
    ? null
    : hookOutput(result.decision, `[guard:${result.rule}] ${result.reason}`);
}

/** Hookens svar för den indata (JSON-text) Claude Code skickar på stdin; ogiltig indata nekas. */
export function runHook(stdin) {
  try {
    return decide(JSON.parse(stdin));
  } catch (error) {
    return hookOutput(
      'deny',
      `[guard:bad-input] Spärren kunde inte läsa hookens indata (${error.message}).`,
    );
  }
}
