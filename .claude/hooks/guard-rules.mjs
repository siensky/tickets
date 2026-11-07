/**
 * Vad spärren (guard.mjs) nekar, frågar om eller släpper igenom, per program. Tabellerna följer
 * rules.md §12 och neka-reglerna i .claude/settings.json; ändras den ena ska den andra ses över.
 *
 * Fallgrop: git har en vitlista. Ett underkommando som inte står här nekas, eftersom det kan vara ett
 * alias för `commit` eller `push`.
 */

import { SECRET_PATH } from './guard-paths.mjs';
import {
  checkGitGrepIgnore,
  checkRecursiveGrep,
  checkRgIgnore,
  checkSearchPaths,
} from './guard-search.mjs';

const words = (text) => new Set(text.split(' '));

export const ASK_USER = 'Be användaren köra kommandot själv (rules.md §12).';

const GIT_READ_ONLY = words(
  'status diff log show rev-parse ls-files ls-tree blame grep describe shortlog cat-file merge-base rev-list ' +
    'show-ref for-each-ref name-rev check-ignore whatchanged help version var count-objects range-diff cherry',
);
const BRANCH_LIST_OPTION =
  /^(--list|-l|-a|--all|-r|--remotes|-v|-vv|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/;
const GIT_READ_FORMS = {
  branch: (rest) => rest.every((a) => BRANCH_LIST_OPTION.test(a)),
  stash: (rest) => ['list', 'show'].includes(rest[0]),
  worktree: (rest) => rest[0] === 'list',
  remote: (rest) => rest.length === 0 || ['-v', 'show', 'get-url'].includes(rest[0]),
  config: (rest) => rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)),
  reflog: (rest) => rest.length === 0 || rest[0] === 'show',
  tag: (rest) => rest.length === 0 || /^(-l|--list)$/.test(rest[0]),
};
const GIT_ASK = words(
  'checkout switch restore stash branch worktree fetch init apply notes gc prune config remote submodule ' +
    'sparse-checkout bisect format-patch archive clone',
);
const GIT_VALUE_OPTIONS = words('-C --git-dir --work-tree --namespace --super-prefix');
// Bara för felmeddelandet: allt som inte står i vitlistorna ovan nekas ändå.
const GIT_KNOWN_WRITES = words(
  'add commit push merge rebase reset cherry-pick revert tag clean pull am rm mv filter-branch update-ref ' +
    'update-index read-tree write-tree commit-tree symbolic-ref replace hash-object',
);

const KUBECTL_WRITE = words(
  'apply create delete patch replace edit scale autoscale set label annotate taint drain cordon uncordon expose run certificate',
);
const KUBECTL_VALUE_OPTIONS = words(
  '-n --namespace --context --cluster --user -s --server --kubeconfig',
);
const TERRAFORM_WRITE = words(
  'apply destroy import state taint untaint force-unlock workspace',
);

export const SHELLS = words('sh bash zsh dash ksh fish');
// Skalets nyckelord före ett kommando (`if git …`, `do git …`): kommandot efter dem bedöms.
export const SHELL_KEYWORDS = words('if then else elif do while until ! { }');
// Flaggor som tar ett värde, per omslagare. En flagga som saknas här och ändå tar ett värde gör att
// värdet tolkas som programmet; för de vanliga omslagarna är listan därför fullständig.
const WRAPPER_VALUE_OPTIONS = {
  env: words('-u --unset -C --chdir'),
  timeout: words('-s --signal -k --kill-after'),
  nice: words('-n --adjustment'),
  sudo: words('-u -g -C -h -p -U -r -t -D'),
  doas: words('-u -C'),
  xargs: words('-n -L -P -E -I -J -R -S -s -d -a'),
  stdbuf: words('-i -o -e'),
  caffeinate: words('-t -w'),
  watch: words('-n --interval -d'),
  exec: words('-a'),
};
export const WRAPPERS = words(
  'env command builtin exec nohup nice time timeout sudo doas xargs watch stdbuf caffeinate unbuffer chronic',
);
export const RUNNER_VALUE_OPTIONS = words(
  '--filter -F --dir -C --reporter --loglevel -p --package --workspace',
);

/**
 * Vad en omslagare kör: `{ script }` för `env -S '…'`, annars `{ assignments, words }`. `timeout` tar
 * dessutom en tid före kommandot.
 */
export function wrapperTarget(program, args) {
  if (program === 'env') {
    const index = args.findIndex(
      (a) => /^(-[a-zA-Z]*S|--split-string)(=|$)/.test(a.text) || /^-S./.test(a.text),
    );
    if (index !== -1) {
      const inline = /^(?:-S|--split-string=)(.+)$/.exec(args[index].text)?.[1];
      return { script: inline ?? args[index + 1]?.text ?? '' };
    }
  }
  const inner = skipOptions(args, WRAPPER_VALUE_OPTIONS[program] ?? new Set());
  let i = 0;
  while (
    program === 'env' &&
    i < inner.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(inner[i].text)
  )
    i += 1;
  const rest = inner.slice(i);
  return {
    assignments: inner.slice(0, i),
    words: program === 'timeout' ? rest.slice(1) : rest,
  };
}

// Tolkar efter programnamn (`python3.12`, `nodejs`, `tsx` …): flaggan som tar kod som argument och de
// flaggor som bara skriver ut version eller hjälp (för `python -v` betyder -v utförlig, inte version).
const INTERPRETERS = [
  [
    /^(node|nodejs|tsx|ts-node|bun)$/,
    (a) => /^-[a-zA-Z]*[ep][a-zA-Z]*$|^--(eval|print)$/.test(a),
    words('-v --version -h --help'),
  ],
  [
    /^(python|pypy)(\d+(\.\d+)?)?$/,
    (a) => /^-[a-zA-Z]*c$/.test(a),
    words('-V --version -h --help'),
  ],
  [/^perl[\d.]*$/, (a) => /^-[a-zA-Z]*[eE][a-zA-Z]*$/.test(a), words('--version -v --help')],
  [/^ruby[\d.]*$/, (a) => /^-[a-zA-Z]*e$/.test(a), words('--version --help')],
  [/^php[\d.]*$/, (a) => a === '-r', words('-v --version -h --help')],
  [/^osascript$/, (a) => a === '-e', words('')],
];

/** Om programmet är en tolk: `{ codes(args), isInfoOnly(args) }`, annars `null`. */
export function interpreterOf(program) {
  if (program === 'deno') {
    return {
      codes: (args) => (args[0]?.text === 'eval' ? [args[1]?.text ?? ''] : []),
      isInfoOnly: (args) => args.length === 1 && args[0].text === '--version',
    };
  }
  const entry = INTERPRETERS.find(([name]) => name.test(program));
  if (entry === undefined) return null;
  const [, takesCode, infoFlags] = entry;
  return {
    codes: (args) =>
      args.flatMap((arg, i) => {
        const inline = /^--(eval|print)=([\s\S]*)$/.exec(arg.text);
        if (inline !== null) return [inline[2]];
        return takesCode(arg.text) && !infoFlags.has(arg.text)
          ? [args[i + 1]?.text ?? '']
          : [];
      }),
    isInfoOnly: (args) => args.length === 1 && infoFlags.has(args[0].text),
  };
}

const INLINE_DANGER = new RegExp(
  [
    String.raw`\bgit\b[^\n;|&]*\b(add|commit|push|merge|rebase|reset|cherry-pick|revert|clean|pull|am|filter-branch|update-ref)\b`,
    String.raw`\bkubectl\b[^\n;|&]*\b(apply|create|delete|patch|replace|edit|scale|set|drain)\b`,
    String.raw`\bterraform\b[^\n;|&]*\b(apply|destroy|import|state)\b`,
    String.raw`\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]`,
    String.raw`loadtest-mode\.sh`,
  ].join('|'),
);

export const deny = (rule, reason) => ({ decision: 'deny', rule, reason });
const fromSearch = (finding) => (finding === null ? null : deny(finding.rule, finding.reason));
const ask = (rule, reason) => ({ decision: 'ask', rule, reason });

/** Starkaste beslutet vinner: deny före ask före inget beslut (`null`). */
export function strongest(results) {
  return (
    results.find((r) => r?.decision === 'deny') ??
    results.find((r) => r?.decision === 'ask') ??
    null
  );
}

/** Hoppar över flaggor (och flaggornas värden) fram till första vanliga argumentet. */
export function skipOptions(args, valueOptions) {
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-') && args[i].text !== '--') {
    i += valueOptions.has(args[i].text) ? 2 : 1;
  }
  return args.slice(args[i]?.text === '--' ? i + 1 : i);
}

function gitSubcommandIndex(args) {
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const option = args[i].text;
    if (
      option === '-c' ||
      option.startsWith('--config-env') ||
      option.startsWith('--exec-path')
    ) {
      return { override: option };
    }
    i += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return { index: i };
}

function checkGit(args) {
  const { override, index } = gitSubcommandIndex(args);
  if (override !== undefined) {
    return deny(
      'git-override',
      `git ${override} kan byta ut vad git kör och är inte tillåtet. ${ASK_USER}`,
    );
  }
  const sub = args[index];
  if (sub === undefined) return null;
  if (sub.dynamic)
    return deny('git-dynamic', 'git-underkommandot avgörs först när kommandot körs.');
  const rest = args.slice(index + 1).map((a) => a.text);
  if (sub.text === 'apply' && rest.some((a) => a === '--index' || a === '--cached')) {
    return deny(
      'git-write',
      `git apply med --index eller --cached lägger till i indexet. ${ASK_USER}`,
    );
  }
  // En pager eller extern diff kör ett annat program; --output skriver till en valfri fil.
  const runsProgram =
    (sub.text === 'grep' && rest.some((a) => /^(-O|--open-files-in-pager)/.test(a))) ||
    rest.includes('--ext-diff') ||
    rest.some((a) => /^--output(=|$)/.test(a));
  if (runsProgram) {
    return deny(
      'git-exec',
      `git ${sub.text} med pager, extern diff eller --output kör ett annat program eller skriver en fil.`,
    );
  }
  const ignored = sub.text === 'grep' ? checkGitGrepIgnore(rest) : null;
  if (ignored !== null) return deny(ignored.rule, ignored.reason);
  if (GIT_READ_ONLY.has(sub.text) || GIT_READ_FORMS[sub.text]?.(rest)) return null;
  if (GIT_ASK.has(sub.text))
    return ask('git-mutating', `git ${sub.text} ändrar arbetskatalogen eller repot.`);
  const what = GIT_KNOWN_WRITES.has(sub.text)
    ? 'skriver till repot'
    : 'är ett okänt underkommando (kan vara ett alias)';
  return deny('git-write', `git ${sub.text} ${what}. ${ASK_USER}`);
}

function checkKubectl(args) {
  const [first, second] = skipOptions(args, KUBECTL_VALUE_OPTIONS).map((a) => a.text);
  const isRolloutWrite =
    first === 'rollout' && ['restart', 'undo', 'pause', 'resume'].includes(second);
  if (KUBECTL_WRITE.has(first) || isRolloutWrite)
    return deny('kubectl-write', `kubectl ${first} ändrar klustret. ${ASK_USER}`);
  // Även läsning nekas: produktionen sköter användaren (CLAUDE.md), och `get secret` visar hemligheter.
  return deny('prod-tool', `kubectl mot klustret kör användaren själv. ${ASK_USER}`);
}

// Terraform-kommandon som inte rör state eller leverantörernas inloggning. Allt annat, med eller utan
// flaggor före underkommandot (`-chdir=… output`), nekas.
const TERRAFORM_LOCAL = words('fmt validate version');

function checkTerraform(args) {
  const sub = args.find((a) => !a.text.startsWith('-'))?.text;
  if (sub === undefined || TERRAFORM_LOCAL.has(sub)) return null;
  const rule = TERRAFORM_WRITE.has(sub) ? 'terraform-write' : 'prod-tool';
  return deny(rule, `terraform ${sub} rör infrastrukturen eller dess state. ${ASK_USER}`);
}

/** Produktionsverktyg som användaren kör själv, oavsett flaggor och omslag (`env`, `sudo`, `xargs`). */
const denyProdTool = () =>
  deny('prod-tool', `Produktionsverktyg kör användaren själv. ${ASK_USER}`);

function checkRm(args) {
  const flags = args.map((a) => a.text).filter((t) => t.startsWith('-'));
  const isRecursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f));
  const isForced = flags.some((f) => f === '--force' || /^-[a-zA-Z]*f/.test(f));
  return isRecursive && isForced
    ? deny('rm-rf', 'rm -rf kräver att användaren tillfrågas (rules.md §12).')
    : null;
}

function checkGh(args) {
  const [first, second] = args.map((a) => a.text);
  const isMerge = first === 'pr' && second === 'merge';
  const isDelete = ['repo', 'release'].includes(first) && second === 'delete';
  return isMerge || isDelete
    ? deny('gh-write', `gh ${first} ${second} är förbjudet. ${ASK_USER}`)
    : null;
}

function checkRg(args) {
  const runsPreprocessor = args.some((a) => /^--pre(=|$)/.test(a.text));
  if (runsPreprocessor) return deny('rg-pre', 'rg --pre kör ett annat program för varje fil.');
  return fromSearch(checkRgIgnore(args) ?? checkSearchPaths(args));
}

function checkGrep(args) {
  return fromSearch(checkRecursiveGrep(args) ?? checkSearchPaths(args));
}

/** Kontroller per program för de program som inte kör andra kommandon. */
export const PROGRAM_CHECKS = {
  git: checkGit,
  kubectl: checkKubectl,
  terraform: checkTerraform,
  rm: checkRm,
  gh: checkGh,
  rg: checkRg,
  grep: checkGrep,
  egrep: checkGrep,
  fgrep: checkGrep,
  zgrep: checkGrep,
  ggrep: checkGrep,
  ...Object.fromEntries(
    ['helm', 'ssh', 'scp', 'sftp', 'rsync', 'psql', 'pg_dump', 'pg_restore', 'redis-cli'].map(
      (name) => [name, denyProdTool],
    ),
  ),
};

/**
 * `pnpm exec`, `pnpm dlx`, `npx`, `npm exec`, `yarn dlx`: `{ words }` för kommandot de kör, `{ script }`
 * när de kör en skalsträng (`-c`, `--shell-mode`, `--call`), annars `null`.
 */
export function wrappedByRunner(program, args) {
  const runs = {
    pnpm: ['exec', 'dlx'],
    npm: ['exec', 'x'],
    yarn: ['exec', 'dlx'],
    bun: ['x'],
  }[program];
  const isDirect = ['npx', 'pnpx', 'bunx'].includes(program);
  const rest = skipOptions(args, RUNNER_VALUE_OPTIONS);
  if (!isDirect && !runs?.includes(rest[0]?.text)) return null;
  const after = isDirect ? args : rest.slice(1);
  const shellFlag = after.findIndex((a) => /^(-c|--shell-mode|--call)(=|$)/.test(a.text));
  if (shellFlag !== -1) {
    const inline = /^--call=([\s\S]*)$/.exec(after[shellFlag].text);
    return { script: inline?.[1] ?? after[shellFlag + 1]?.text ?? '' };
  }
  return { words: skipOptions(after, RUNNER_VALUE_OPTIONS) };
}

// Verifieringsposten och försöksräknaren skrivs bara av verify.mjs (ADR-0012). Kod som nämner både
// .claude och state nekas, eftersom sökvägen kan byggas ihop i koden (`join('.claude', 'state')`).
const MENTIONS_VERIFY_STATE = (code) => /\.claude/.test(code) && /state/.test(code);
const MENTIONS_CLAUDE_CONFIG = (code) =>
  /\.claude/.test(code) && /hooks|agents|skills|settings/.test(code);
// Program som bara läser. Alla andra som nämner .claude/state/ nekas (vitlista, som för git), så att
// varken posten eller försöksräknaren kan skrivas eller nollställas av någon annan än användaren.
// (less och more är inte med: `less -o fil` skriver.)
export const STATE_READERS = words('cat head tail jq ls wc grep rg diff stat file tree du');
// Program som kan ta bort, flytta eller skriva över hela mappen .claude.
export const DIR_WRITERS = words('rm rmdir mv cp chmod chown ln rsync tar unlink shred');
export const denyStateWrite = () =>
  deny('verify-state', 'Bara verify.mjs skriver i .claude/state/. Kör /verify i stället.');
// Hooks, agenter, skills och settings ändras med Edit/Write (som frågar), inte med Bash. Program som
// bara kör eller formaterar filerna får nämna dem.
export const CONFIG_NON_WRITERS = words('node vitest prettier eslint gitleaks');
export const denyConfigWrite = () =>
  deny(
    'claude-config',
    'Hooks, agenter, skills och settings ändras med Edit/Write (som frågar), inte med Bash. Läs dem med Read, cat eller rg.',
  );

/** Kod som körs inline (`node -e`, `python -c`, heredoc till en tolk) granskas som text. */
export function checkInlineCode(code) {
  if (MENTIONS_VERIFY_STATE(code)) return denyStateWrite();
  if (MENTIONS_CLAUDE_CONFIG(code)) return denyConfigWrite();
  if (SECRET_PATH.test(code)) {
    return deny(
      'secret-path',
      'Koden nämner en fil med hemligheter (.env, tfstate, kubeconfig).',
    );
  }
  return INLINE_DANGER.test(code)
    ? deny('inline-code', `Koden kör ett kommando som är förbjudet. ${ASK_USER}`)
    : null;
}
