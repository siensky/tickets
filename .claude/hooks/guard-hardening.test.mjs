/**
 * Regressionstester för luckor i spärren som granskningarna hittade: sökning (grep -r, rg -u, rg -g,
 * git grep --no-index, sökningar i hemkatalogen) når hemliga filer utan att nämna dem, produktionsverktyg
 * nekas oavsett flaggor och omslag, hooks/settings skrivs inte via Bash, och spärren blockerade inte om
 * den själv inte gick att läsa in. Att rg -g och -u läser gitignorerade filer är verifierat med rg 14.1.1.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateCommand } from './guard-core.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));

const DENIED = [
  ['grep -rn api_token .', 'grep-recursive'],
  ['grep -R hcloud infra', 'grep-recursive'],
  ['grep -nri token infra', 'grep-recursive'],
  ['grep --recursive token infra', 'grep-recursive'],
  ['grep --dereference-recursive token .', 'grep-recursive'],
  ['grep -d recurse token .', 'grep-recursive'],
  ['grep --directories=recurse token .', 'grep-recursive'],
  ['egrep -r token infra', 'grep-recursive'],
  ['grep -rC2 token infra', 'grep-recursive'],
  ['grep -rm1 token infra', 'grep-recursive'],
  ['grep -nd recurse token infra', 'grep-recursive'],
  ['grep --directories recurse token infra', 'grep-recursive'],
  ['grep --rec token infra', 'grep-recursive'],
  ['find . -name x -exec grep -r token {} +', 'stdin-args'],
  ['find infra -type f -exec grep token {} +', 'stdin-args'],
  ['find infra -type f | xargs grep token', 'stdin-args'],
  ['git ls-files | xargs grep -rl token', 'stdin-args'],
  ['rg -uA2 token infra', 'rg-no-ignore'],
  ['rg -.u token infra', 'rg-no-ignore'],
  ['rg -.uu token .', 'rg-no-ignore'],
  ["rg -.g '*' token infra", 'rg-glob'],
  ['rg --hidden server ~/.kube', 'secret-path'],
  ['rg --hidden oauth ~/.config', 'secret-path'],
  ['rg token ~/Documents', 'search-outside-project'],
  [
    `node -e "require('fs').writeFileSync('.claude/hooks/guard-core.mjs','')"`,
    'claude-config',
  ],
  [`python3 -c "open('.claude/settings.json','w')"`, 'claude-config'],
  ['sed -i "" s/a/b/ .claude/managed-settings.example.json', 'claude-config'],
  ['rg --hidden -g config token infra', 'rg-glob'],
  ["rg -g '*rekey*' token infra", 'rg-glob'],
  ["rg -g 'config' token .", 'rg-glob'],
  ['rg --hidden hcloud ~', 'search-outside-project'],
  ['rg -. token /Users/siennalansky', 'search-outside-project'],
  ['rg --hidden -l token ..', 'search-outside-project'],
  ['rg token ../other', 'search-outside-project'],
  ['grep token ~', 'search-outside-project'],
  ['rg token ~/.ssh', 'secret-path'],
  ['ls ~/.aws', 'secret-path'],
  ['git grep --no-ind token infra', 'git-grep-ignored'],
  ['git grep --untracked --no-exclude token', 'git-grep-ignored'],
  // ADR-0013: produktionen kör användaren, även läsning. Tidigare släpptes dessa tre igenom av guarden.
  ['kubectl get pods', 'prod-tool'],
  ['kubectl -n ticketing get pods', 'prod-tool'],
  ['kubectl rollout status deploy/booking-api', 'prod-tool'],
  ['env kubectl get secret -A -o yaml', 'prod-tool'],
  ['sudo -n kubectl get ns', 'prod-tool'],
  ['helm list', 'prod-tool'],
  ['ssh host', 'prod-tool'],
  ['psql -h db', 'prod-tool'],
  ['terraform plan', 'prod-tool'],
  ['terraform console', 'prod-tool'],
  ['terraform -chdir=infra/terraform output -json', 'prod-tool'],
  ['sed -i "" s/a/b/ .claude/hooks/guard-core.mjs', 'claude-config'],
  ['cp /tmp/x .claude/settings.json', 'claude-config'],
  ['echo x > .claude/agents/reviewer.md', 'claude-config'],
  ['rm .claude/skills/phase/SKILL.md', 'claude-config'],
  ['rg -u token infra', 'rg-no-ignore'],
  ['rg -uu token .', 'rg-no-ignore'],
  ['rg -lu token .', 'rg-no-ignore'],
  ['rg --unrestricted token .', 'rg-no-ignore'],
  ['rg --no-ignore token .', 'rg-no-ignore'],
  ['rg --no-ignore-vcs token .', 'rg-no-ignore'],
  ["rg -g '*' token infra", 'rg-glob'],
  ["rg --glob '*' token infra", 'rg-glob'],
  ["rg --glob='*state*' token .", 'rg-glob'],
  ["rg --iglob '*' token .", 'rg-glob'],
  ["rg -g 'infra/**' token .", 'rg-glob'],
  ["rg -g 'terraform' token .", 'rg-glob'],
  ["rg -g '*.ts' -g '*' token .", 'rg-glob'],
  ['rg -g "$PATTERN" token .', 'rg-glob'],
  ['git grep --no-index token infra', 'git-grep-ignored'],
  ['git grep --no-exclude-standard token', 'git-grep-ignored'],
];

const ALLOWED = [
  'grep -n token apps/web/src/lib/seat-status.ts',
  'grep -c token notes.txt',
  'grep -e token -- -r',
  'echo token | grep -i token',
  'rg token services',
  'rg -l -i token',
  'rg --hidden token .',
  "rg -g '*.ts' token services",
  "rg --glob '*.mjs' token .claude",
  "rg -g '!node_modules' token .",
  "rg -tjs -U 'a.b' apps",
  "rg -g 'src/**/*.ts' token .",
  'git grep -n token -- services',
  'terraform fmt -check',
  'terraform validate',
  'node .claude/hooks/verify.mjs',
  'pnpm exec vitest run .claude/hooks',
  'pnpm exec prettier --write .claude/skills/phase/SKILL.md',
  'cat .claude/hooks/guard.mjs',
  'gitleaks detect --no-git --redact --source .claude/hooks',
  'rg token .claude/hooks',
  'git diff --stat -- .claude/skills',
];

describe('sökspärrar mot hemliga filer', () => {
  it.each(DENIED)('nekar %s', (command, rule) => {
    expect(evaluateCommand(command)).toMatchObject({ decision: 'deny', rule });
  });

  it.each(ALLOWED)('släpper igenom %s', (command) => {
    expect(evaluateCommand(command)).toBeNull();
  });
});

describe('guard.mjs blockerar när den själv inte går att läsa in', () => {
  const dirs = [];
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  const hookCopy = (skip = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(HOOKS).filter((f) =>
      /^guard.*\.mjs$|^shell-words\.mjs$/.test(f),
    ))
      if (!skip.includes(file) && !file.endsWith('.test.mjs'))
        copyFileSync(join(HOOKS, file), join(dir, file));
    return dir;
  };
  const run = (dir) =>
    spawnSync('node', [join(dir, 'guard.mjs')], { input, encoding: 'utf8' });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('fungerar som vanligt när alla filer finns (kontroll av testuppställningen)', () => {
    expect(run(hookCopy())).toMatchObject({ status: 0, stdout: '' });
  });

  it.each(['guard-core.mjs', 'guard-rules.mjs', 'guard-paths.mjs', 'guard-search.mjs'])(
    'ger exit 2 när %s saknas',
    (missing) => {
      const result = run(hookCopy([missing]));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('[guard:crash]');
    },
  );

  it('ger exit 2 när en importerad fil har ett syntaxfel', () => {
    const dir = hookCopy();
    writeFileSync(join(dir, 'guard-rules.mjs'), 'export const x = ;\n');
    const result = run(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('[guard:crash]');
  });
});
