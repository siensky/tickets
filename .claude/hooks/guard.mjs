/**
 * PreToolUse-hook för Bash och Monitor (ADR-0012, rules.md §12). Andra lagret efter neka-reglerna i
 * .claude/settings.json: fångar kommandovägar som reglerna inte ser, som `git -C . commit`,
 * `sh -c '…'`, `$(…)`, `pnpm exec git …`, git-alias och `node -e`/`python -c` som nämner git eller
 * en hemlig fil. Vad som nekas per program står i guard-rules.mjs.
 *
 * Fallgrop: spärren läser kommandotexten. Ett skript som bygger ihop kommandot när det körs går inte
 * att bedöma; det blir en vanlig fråga till användaren eftersom tolkarna aldrig är tillåtna. Vid fel i
 * själva hooken nekas kommandot (fail closed), och `onFailure: "block"` täcker en krasch.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASK_USER,
  CODE_FLAGS,
  FILE_WRITERS,
  INFO_FLAGS,
  VERIFY_STATE,
  denyStateWrite,
  PROGRAM_CHECKS,
  RUNNER_VALUE_OPTIONS,
  SECRET_PATH,
  SHELL_KEYWORDS,
  SHELLS,
  WRAPPER_VALUE_OPTIONS,
  WRAPPERS,
  checkInlineCode,
  deny,
  skipOptions,
  strongest,
} from './guard-rules.mjs';
import { splitCommands } from './shell-words.mjs';

const MAX_DEPTH = 6;

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
  if (file.length > 0) return evaluateWords(file, command, depth + 1);
  return deny('shell-stdin', 'Ett skal som läser sitt skript från stdin går inte att bedöma.');
}

function checkInterpreter(program, args, command) {
  const flagIndex = args.findIndex((a) => CODE_FLAGS[program].includes(a.text));
  if (flagIndex !== -1) return checkInlineCode(args[flagIndex + 1]?.text ?? '');
  if (command.heredocs.length > 0)
    return strongest(command.heredocs.map((body) => checkInlineCode(body)));
  if (args.some((a) => INFO_FLAGS.has(a.text))) return null;
  const hasScriptFile = skipOptions(args, new Set()).some((a) => a.text !== '-');
  return hasScriptFile
    ? null
    : deny('interpreter-stdin', 'Kod som läses från stdin går inte att bedöma.');
}

/** `pnpm exec`, `pnpm dlx`, `npx`, `npm exec`, `yarn dlx`: orden för kommandot de kör, annars `null`. */
function wrappedByRunner(program, args) {
  if (['npx', 'pnpx', 'bunx'].includes(program))
    return skipOptions(args, RUNNER_VALUE_OPTIONS);
  const runs = {
    pnpm: ['exec', 'dlx'],
    npm: ['exec', 'x'],
    yarn: ['exec', 'dlx'],
    bun: ['x'],
  }[program];
  const rest = skipOptions(args, RUNNER_VALUE_OPTIONS);
  return runs?.includes(rest[0]?.text)
    ? skipOptions(rest.slice(1), RUNNER_VALUE_OPTIONS)
    : null;
}

function stripAssignments(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text)) i += 1;
  return words.slice(i);
}

/** Orden efter en omslagare som `env`, `timeout` eller `xargs`, alltså kommandot den kör. */
function unwrap(program, args) {
  const inner = skipOptions(args, WRAPPER_VALUE_OPTIONS);
  if (program === 'env') return stripAssignments(inner);
  return program === 'timeout' ? inner.slice(1) : inner;
}

function evaluateWords(words, command, depth) {
  if (depth > MAX_DEPTH)
    return deny('too-deep', 'Kommandot är för djupt nästlat för att bedömas.');
  const [programWord, ...args] = stripAssignments(words);
  if (programWord === undefined) return null;
  if (programWord.dynamic)
    return deny('dynamic-program', 'Programnamnet avgörs först när kommandot körs.');
  const program = basename(programWord.text);
  if (SHELL_KEYWORDS.has(program)) return evaluateWords(args, command, depth + 1);
  if (WRAPPERS.has(program)) return evaluateWords(unwrap(program, args), command, depth + 1);
  const runnerTarget = wrappedByRunner(program, args);
  if (runnerTarget !== null) return evaluateWords(runnerTarget, command, depth + 1);
  if (program === 'eval') return evaluateCommand(args.map((a) => a.text).join(' '), depth + 1);
  if (program.endsWith('loadtest-mode.sh')) {
    return deny('loadtest-mode', `Lasttestläget ändrar produktionen. ${ASK_USER}`);
  }
  if (SHELLS.has(program)) return checkShell(args, command, depth);
  if (program in CODE_FLAGS) return checkInterpreter(program, args, command);
  if (FILE_WRITERS.has(program) && args.some((a) => VERIFY_STATE.test(a.text))) {
    return denyStateWrite();
  }
  return PROGRAM_CHECKS[program]?.(args) ?? null;
}

function evaluateSimple(command, depth) {
  if (command.redirects.some((r) => VERIFY_STATE.test(r.text))) return denyStateWrite();
  const mentionsSecret = [...command.words, ...command.redirects].some((w) =>
    SECRET_PATH.test(w.text),
  );
  if (mentionsSecret) {
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

function main() {
  let output;
  try {
    output = decide(JSON.parse(readFileSync(0, 'utf8')));
  } catch (error) {
    output = hookOutput(
      'deny',
      `[guard:bad-input] Spärren kunde inte läsa hookens indata (${error.message}).`,
    );
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
