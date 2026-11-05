/**
 * Spärrhooken (guard.mjs). BYPASS_PATHS är de 18 kommandovägarna från granskningen av spärrarna:
 * de flesta av dem släpper neka-reglerna i settings.json igenom som en vanlig fråga, så här måste
 * spärren neka dem. MUST_PASS är vardagskommandon som inte får blockeras, annars blir spärren
 * något man vill stänga av.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, evaluateCommand } from './guard.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');

const BYPASS_PATHS = [
  ['git commit -m x', 'git-write'],
  ['git commit', 'git-write'],
  ['git -C . commit -m x', 'git-write'],
  ['git -c core.editor=true commit -m x', 'git-override'],
  ['git ci -m x', 'git-write'],
  ['/usr/bin/git push origin main', 'git-write'],
  ['GIT_AUTHOR_NAME=x git commit -m x', 'git-write'],
  ['echo ok && git commit -m x', 'git-write'],
  ["sh -c 'git commit -m x'", 'git-write'],
  ['bash -lc "cd /tmp && git push"', 'git-write'],
  ['echo "$(git commit -m x)"', 'git-write'],
  ['echo `git push`', 'git-write'],
  ['pnpm --filter . exec git commit -m x', 'git-write'],
  ['env FOO=1 git push', 'git-write'],
  [`node -e "require('child_process').execSync('git commit -m x')"`, 'inline-code'],
  [`python3 -c "print(open('.env').read())"`, 'secret-path'],
  ['G=git; $G commit -m x', 'dynamic-program'],
  ["bash <<'EOF'\ngit push\nEOF", 'git-write'],
];

const MORE_BYPASSES = [
  ['for f in a b; do git add "$f"; done', 'git-write'],
  ['if true; then git push; fi', 'git-write'],
  ['timeout 5 git push', 'git-write'],
  ['xargs -I {} git commit -m {} < list.txt', 'git-write'],
  ['npx --yes git push', 'git-write'],
  ['eval "git commit -m x"', 'git-write'],
  ['echo git push | bash', 'shell-stdin'],
  [
    "python3 - <<'EOF'\nimport subprocess; subprocess.run(['git', 'push'])\nEOF",
    'inline-code',
  ],
  ['git pull', 'git-write'],
  ['git rm file.ts', 'git-write'],
  ['git apply --index fix.patch', 'git-write'],
  ['git tag v1', 'git-write'],
  ['git --exec-path=/tmp status', 'git-override'],
  ['cat apps/web/.env', 'secret-path'],
  ['cp infra/terraform/terraform.tfstate /tmp/x', 'secret-path'],
  ['echo x > .env.local', 'secret-path'],
  ['KUBECONFIG=infra/terraform/.kube/config kubectl get pods', 'secret-path'],
  ['source ~/.tikknet-tf.env', 'secret-path'],
  ['kubectl --context prod delete ns ticketing', 'kubectl-write'],
  ["sh -c 'kubectl -n ticketing scale deploy/booking-api --replicas=0'", 'kubectl-write'],
  ['kubectl rollout restart deploy/booking-api', 'kubectl-write'],
  ['terraform -chdir=infra/terraform apply', 'terraform-write'],
  ['rm -fr /tmp/x', 'rm-rf'],
  ['rm -r -f build', 'rm-rf'],
  ['./scripts/loadtest-mode.sh on', 'loadtest-mode'],
  ['bash scripts/loadtest-mode.sh off', 'loadtest-mode'],
  ['gh pr merge 27 --squash', 'gh-write'],
];

const MUST_PASS = [
  'git status --short',
  'git diff --stat main...HEAD',
  'git log --oneline -5',
  'git -C services/booking-api status',
  'git --no-pager show HEAD:docs/plan.md',
  'git branch --show-current',
  'git stash list',
  'git worktree list',
  'git config --get user.email',
  'pnpm lint',
  'pnpm --filter @tickets/booking-api test:integration',
  'pnpm exec vitest run .claude/hooks',
  'npx prettier --check docs',
  'grep -rn "git commit" docs',
  'echo "git push"',
  'cat .env.example',
  'node -e "console.log(1)"',
  'node --version',
  'node scripts/verify-boundaries-enforcement.mjs',
  'S=/tmp/x; node $S/check.mjs "$PWD"',
  'bash -c "git status && git diff"',
  "cat <<'EOF' > notes.md\ngit push står bara i texten\nEOF",
  'kubectl -n ticketing get pods',
  'kubectl rollout status deploy/booking-api',
  'terraform plan',
  'rm -r /tmp/scratch-dir',
  'docker info --format "{{.ServerVersion}}"',
  'ls docs | head -5 2>/dev/null',
];

const MUST_ASK = [
  'git checkout main',
  'git stash',
  'git branch new-feature',
  'git worktree add ../x',
  'git fetch',
];

describe('guard.mjs: de 18 kommandovägarna', () => {
  it.each(BYPASS_PATHS)('nekar %j', (command, rule) => {
    expect(evaluateCommand(command)).toMatchObject({ decision: 'deny', rule });
  });

  it('täcker exakt 18 vägar', () => {
    expect(BYPASS_PATHS).toHaveLength(18);
  });
});

describe('guard.mjs: fler vägar runt reglerna', () => {
  it.each(MORE_BYPASSES)('nekar %j', (command, rule) => {
    expect(evaluateCommand(command)).toMatchObject({ decision: 'deny', rule });
  });
});

describe('guard.mjs: vardagskommandon', () => {
  it.each(MUST_PASS)('släpper igenom %j utan beslut', (command) => {
    expect(evaluateCommand(command)).toBeNull();
  });

  it.each(MUST_ASK)('frågar användaren för %j', (command) => {
    expect(evaluateCommand(command)).toMatchObject({ decision: 'ask', rule: 'git-mutating' });
  });
});

describe('guard.mjs: fail closed', () => {
  it.each([
    "echo 'oavslutat",
    'echo "oavslutat',
    'echo $(git status',
    'cat <<EOF\ningen slutrad',
  ])('nekar %j som inte går att tolka', (command) => {
    expect(decide({ tool_input: { command } })?.hookSpecificOutput.permissionDecision).toBe(
      'deny',
    );
  });

  it('nekar för djupt nästlade skal', () => {
    const nested = Array.from({ length: 9 }).reduce(
      (inner) => `sh -c ${JSON.stringify(inner)}`,
      'git status',
    );
    expect(evaluateCommand(nested)).toMatchObject({ decision: 'deny', rule: 'too-deep' });
  });

  it('har inget beslut för andra verktyg än Bash', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } })).toBeNull();
  });
});

describe('guard.mjs som hook', () => {
  const run = (stdin) => spawnSync('node', [GUARD], { input: stdin, encoding: 'utf8' });

  it('svarar med PreToolUse-JSON och exit 0 när ett kommando nekas', () => {
    const result = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git -C . commit -m x' } }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('[guard:git-write]'),
      },
    });
  });

  it('skriver ingenting när kommandot är okej', () => {
    const result = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('nekar när indata inte är JSON', () => {
    const result = run('inte json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
