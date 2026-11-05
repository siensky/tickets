/**
 * Vad spärren (guard.mjs) nekar, frågar om eller släpper igenom, per program. Tabellerna följer
 * rules.md §12 och neka-reglerna i .claude/settings.json; ändras den ena ska den andra ses över.
 *
 * Fallgrop: git har en vitlista. Ett underkommando som inte står här nekas, eftersom det kan vara ett
 * alias för `commit` eller `push`.
 */

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
export const INFO_FLAGS = words('--version -v -V --help -h');
export const CODE_FLAGS = {
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  bun: ['-e', '--eval'],
  php: ['-r'],
  osascript: ['-e'],
};
export const WRAPPERS = words(
  'env command exec nohup nice time timeout sudo doas xargs watch stdbuf caffeinate unbuffer chronic',
);
export const WRAPPER_VALUE_OPTIONS = words('-n -u -I -P -L -d -E -s -g -k --signal');
export const RUNNER_VALUE_OPTIONS = words(
  '--filter -F --dir -C --reporter --loglevel -p --package --workspace',
);

export const SECRET_PATH =
  /(^|[^\w.-])\.env(\.local|\.[\w-]+\.local)?(?![\w.-])|\.tfstate|\.kube(\/|-config-raw)|\.tikknet-tf\.env/;
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
  if (!KUBECTL_WRITE.has(first) && !isRolloutWrite) return null;
  return deny('kubectl-write', `kubectl ${first} ändrar klustret. ${ASK_USER}`);
}

function checkTerraform(args) {
  const sub = args.find((a) => !a.text.startsWith('-'))?.text;
  if (!TERRAFORM_WRITE.has(sub)) return null;
  return deny('terraform-write', `terraform ${sub} ändrar infrastrukturen. ${ASK_USER}`);
}

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

/** Kontroller per program för de program som inte kör andra kommandon. */
export const PROGRAM_CHECKS = {
  git: checkGit,
  kubectl: checkKubectl,
  terraform: checkTerraform,
  rm: checkRm,
  gh: checkGh,
};

/** Kod som körs inline (`node -e`, `python -c`, heredoc till en tolk) granskas som text. */
export function checkInlineCode(code) {
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
