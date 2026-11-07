/**
 * Kontrollerar Claude Code-konfigurationens form (ADR-0012). Claude Code själv ignorerar en ogiltig
 * settings-fil tyst i `-p`-läge, och `claude doctor` validerar inte projektets inställningar. Då
 * försvinner alla neka-regler utan att någon märker det, så formen kontrolleras här i stället.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));
const { allow, ask, deny } = settings.permissions;

const KNOWN_TOP_LEVEL_KEYS = new Set(['$schema', 'permissions', 'env', 'hooks']);
const RULE_SHAPE = /^(Bash|Read|Edit|WebFetch|Agent|Skill)(\(.+\))?$/;
// Kommandon som kan köra godtycklig kod och därmed ta sig förbi neka-reglerna.
const WRAPPERS =
  /^Bash\((node|python3?|sh|bash|zsh|npx|pnpm (exec|dlx)|pnpm --filter|env|eval|xargs)\b/;
// Projektets eget verifieringsskript, exakt så (inga argument som byter ut stegen).
const VERIFY_COMMANDS = new Set([
  'Bash(node .claude/hooks/verify.mjs)',
  'Bash(node .claude/hooks/verify.mjs --scope full)',
]);
// Mätrapporten: läser bara .claude/metrics/ och tar inga argument.
const REPORT_COMMAND = 'Bash(node .claude/hooks/metrics-report.mjs)';
// CI-läsningen (ADR-0014): körs med utvecklarens gh-inloggning och tar därför inga argument. Absolut
// sökväg, annars matchar regeln en kopia av skriptet i vilken underkatalog som helst.
const CI_LOGS_SCRIPT = '/Users/siennalansky/Downloads/tickets/.claude/hooks/ci-logs.mjs';
const CI_LOGS_COMMAND = `Bash(node ${CI_LOGS_SCRIPT})`;
// Filerna som styr hemlighetskontrollen i pre-commit. Ändras de i tysthet skyddar den inte längre.
const SECRET_SCAN_FILES = ['scripts/check-secrets.sh', '.gitleaks.toml', '.lintstagedrc.json'];
const isIgnored = (path) =>
  spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: REPO }).status === 0;
const hooksFor = (event, script) =>
  (settings.hooks?.[event] ?? [])
    .flatMap((group) => group.hooks)
    .filter((hook) => hook.args?.some((arg) => arg.endsWith(`/.claude/hooks/${script}`)));

describe('.claude/settings.json', () => {
  it('har bara nycklar som projektet använder', () => {
    expect(Object.keys(settings).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key))).toEqual([]);
  });

  // Beslutet att tillåta Auto mode (ADR-0013): bypass-läget är fortfarande av, och skydden nedan gäller
  // före klassificeraren.
  it('stänger av bypass-läget och tillåter Auto mode', () => {
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.permissions.disableAutoMode).toBeUndefined();
  });

  it('nekar produktionsverktyg helt, de räcker inte med en fråga', () => {
    for (const tool of ['kubectl', 'helm', 'ssh', 'scp', 'sftp', 'rsync', 'psql']) {
      expect(deny, tool).toContain(`Bash(${tool} *)`);
      expect(ask, tool).not.toContain(`Bash(${tool} *)`);
    }
    for (const sub of [
      'apply',
      'destroy',
      'import',
      'state',
      'plan',
      'output',
      'show',
      'workspace',
    ]) {
      expect(deny, sub).toContain(`Bash(terraform ${sub} *)`);
    }
    for (const sub of ['merge', 'workflow', 'secret', 'repo', 'release']) {
      expect(deny, sub).toContain(`Bash(gh ${sub === 'merge' ? 'pr merge' : sub} *)`);
    }
  });

  it('frågar innan säkerhetskonfiguration ändras och nekar att hemliga filer ändras', () => {
    for (const path of [
      '/.claude/settings.json',
      '/.claude/hooks/**',
      '/.claude/agents/**',
      '/.claude/skills/**',
      '/.github/workflows/**',
      ...SECRET_SCAN_FILES.map((file) => `/${file}`),
    ]) {
      expect(ask, path).toContain(`Edit(${path})`);
    }
    for (const path of ['/**/.env', '/infra/terraform/**/*.tfstate*', '/.claude/state/**']) {
      expect(deny, path).toContain(`Edit(${path})`);
    }
  });

  it('har regler med giltig form', () => {
    for (const rule of [...allow, ...ask, ...deny]) {
      expect(rule, rule).toMatch(RULE_SHAPE);
    }
  });

  it('nekar git-kommandon som skriver och läsning av hemligheter', () => {
    for (const rule of [
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(git push *)',
      'Bash(git merge *)',
    ]) {
      expect(deny).toContain(rule);
    }
    expect(deny).toContain('Read(/**/.env)');
    expect(deny).toContain('Read(/infra/terraform/**/*.tfstate*)');
    expect(deny).toContain('Read(/infra/terraform/**/.kube/**)');
  });

  it('tillåter aldrig ett kommando som kan köra godtycklig kod', () => {
    const exact = new Set([...VERIFY_COMMANDS, REPORT_COMMAND, CI_LOGS_COMMAND]);
    expect(allow.filter((rule) => WRAPPERS.test(rule) && !exact.has(rule))).toEqual([]);
  });

  it('tillåter CI-läsningen bara exakt så, och aldrig gh självt', () => {
    expect(allow.filter((rule) => rule.includes('ci-logs'))).toEqual([CI_LOGS_COMMAND]);
    expect(allow.filter((rule) => /^Bash\(gh\b/.test(rule))).toEqual([]);
    expect(deny).toContain('Bash(gh pr merge *)');
  });

  it('tillåter mätrapporten bara exakt så', () => {
    expect(allow.filter((rule) => rule.includes('metrics'))).toEqual([REPORT_COMMAND]);
  });

  it('mäter varje verktygsanrop i bakgrunden, så att mätningen aldrig kan stoppa arbetet', () => {
    for (const event of ['PostToolUse', 'PostToolUseFailure', 'SubagentStop']) {
      const hooks = hooksFor(event, 'metrics.mjs');
      expect(hooks, event).toHaveLength(1);
      expect(hooks[0], event).toMatchObject({ type: 'command', command: 'node', async: true });
      expect(hooks[0].onFailure, event).toBeUndefined();
    }
  });

  it('läser tokens en gång när sessionen slutar, utan att kunna hindra avslutet', () => {
    const hooks = hooksFor('SessionEnd', 'metrics.mjs');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].onFailure).toBeUndefined();
    expect(hooks[0].timeout).toBeLessThanOrEqual(5);
  });

  it('håller mätdata utanför git', () => {
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('.claude/metrics/');
  });

  it('håller lokalt tillstånd och personliga inställningar utanför git', () => {
    for (const path of [
      '.claude/state/verify-record.json',
      '.claude/metrics/tools-2026-11.jsonl',
      '.claude/settings.local.json',
      '.claude/worktrees/x',
      '.claude/scheduled_tasks.lock',
    ]) {
      expect(isIgnored(path), path).toBe(true);
    }
    // Står i .gitignore, inte bara i en personlig git-konfiguration som check-ignore också läser.
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('.claude/.cc-writes/');
    const tracked = spawnSync('git', ['ls-files', '.claude/state', '.claude/metrics'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout).toBe('');
  });

  it('versionshanterar konfigurationen, ignoreringen är inte för bred', () => {
    for (const path of [
      '.claude/settings.json',
      '.claude/managed-settings.example.json',
      '.claude/hooks/guard.mjs',
      '.claude/agents/reviewer.md',
      '.claude/skills/verify/SKILL.md',
    ]) {
      expect(isIgnored(path), path).toBe(false);
    }
  });

  it('tillåter verifieringsskriptet bara exakt så och skyddar posten mot redigering', () => {
    expect(allow.filter((rule) => rule.includes('verify.mjs'))).toEqual([...VERIFY_COMMANDS]);
    expect(deny).toContain('Edit(/.claude/state/**)');
  });

  it('kräver en verifieringspost innan sessionen eller en subagent avslutas', () => {
    expect(hooksFor('Stop', 'require-verify.mjs')).toHaveLength(1);
    expect(hooksFor('SubagentStop', 'require-verify.mjs')).toHaveLength(1);
  });

  it('tillåter bara exakta kommandon, aldrig ett jokertecken', () => {
    expect(allow.filter((rule) => rule.includes('*'))).toEqual([]);
  });

  it('har ingen regel som både tillåts och nekas eller frågas', () => {
    const blocked = new Set([...deny, ...ask]);
    expect(allow.filter((rule) => blocked.has(rule))).toEqual([]);
  });

  it('pekar bara på hook-skript som finns', () => {
    const commands = Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((group) => group.hooks)
      .flatMap((hook) => hook.args ?? []);
    for (const arg of commands.filter((value) => value.includes('${CLAUDE_PROJECT_DIR}'))) {
      expect(existsSync(arg.replace('${CLAUDE_PROJECT_DIR}', REPO)), arg).toBe(true);
    }
  });

  it('kör spärren före varje Bash-kommando och blockerar om spärren själv fallerar', () => {
    const guards = (settings.hooks?.PreToolUse ?? [])
      .filter((group) => group.matcher.split('|').includes('Bash'))
      .flatMap((group) => group.hooks)
      .filter((hook) => hook.args?.some((arg) => arg.endsWith('/.claude/hooks/guard.mjs')));
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({ type: 'command', command: 'node', onFailure: 'block' });
  });
});

// Mallen för managed settings (installeras av användaren med sudo, ADR-0013). Sandboxen och nätverkslistan
// är det som faktiskt håller produktion och hemligheter utom räckhåll, så de låses här.
describe('.claude/managed-settings.example.json', () => {
  const managed = JSON.parse(
    readFileSync(join(REPO, '.claude/managed-settings.example.json'), 'utf8'),
  );
  const { sandbox } = managed;

  it('slår på sandboxen och tillåter bara npm på nätet', () => {
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    expect(sandbox.network).toEqual({
      allowedDomains: ['registry.npmjs.org', '*.npmjs.org'],
      allowManagedDomainsOnly: true,
    });
  });

  it('undantar bara verifieringen och testkörarna från sandboxen', () => {
    expect(sandbox.excludedCommands).toEqual([
      'node .claude/hooks/verify.mjs',
      'node .claude/hooks/verify.mjs --scope full',
      `node ${CI_LOGS_SCRIPT}`,
      'pnpm test:integration',
      'pnpm test:contract',
    ]);
  });

  // ADR-0014: CI-loggarna läses via skriptet, inte genom att ge sandboxen gh-inloggningen.
  it('håller gh-inloggningen och GitHub utom räckhåll för sandboxade kommandon', () => {
    expect(sandbox.filesystem.denyRead.join('\n')).toContain('/.config/gh');
    const denied = sandbox.credentials.envVars.filter((v) => v.mode === 'deny');
    expect(denied.map((v) => v.name)).toEqual(
      expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']),
    );
    expect(sandbox.excludedCommands.filter((command) => /^gh\b/.test(command))).toEqual([]);
  });

  it('skyddar hemliga filer och nekar produktion och git-skrivande, utan att tillåta något', () => {
    // Hela infra/terraform ger EPERM i prettier; därför de hemliga filerna (ADR-0013, "Vad som provats").
    expect(sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/infra\/terraform\/terraform\.tfstate\*$/),
        expect.stringMatching(/infra\/terraform\/\.kube\/config$/),
        expect.stringMatching(/infra\/terraform\/\.kube-config-raw$/),
        expect.stringMatching(/tests\/e2e\/\.env\.local$/),
      ]),
    );
    expect(managed.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(kubectl *)',
        'Bash(helm *)',
        'Bash(ssh *)',
        'Bash(psql *)',
        'Bash(git push *)',
        'Bash(git commit *)',
        'Bash(gh pr merge *)',
      ]),
    );
    expect(managed.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(managed.permissions.allow).toBeUndefined();
  });

  it('skriv- och lässkyddar säkerhetskonfigurationen och hemligheterna i sandboxen', () => {
    const write = sandbox.filesystem.denyWrite.join('\n');
    for (const path of [
      '.claude/hooks',
      '.claude/agents',
      '.claude/skills',
      '.claude/settings.json',
    ])
      expect(write, path).toContain(path);
    expect(write).toContain('.github/workflows');
    for (const file of SECRET_SCAN_FILES) expect(write, file).toContain(file);
    const read = sandbox.filesystem.denyRead.join('\n');
    for (const path of ['.tikknet-tf.env', '/.ssh', '/.aws', '/.kube', 'infra/terraform'])
      expect(read, path).toContain(path);
    expect(sandbox.credentials.envVars.map((v) => v.mode)).not.toContain('allow');
  });

  it('frågar innan mallen ändras, eftersom användaren installerar den som root', () => {
    expect(ask).toContain('Edit(/.claude/managed-settings.example.json)');
  });
});

// `ci-ok` är den slutliga kontrollen (ADR-0012). Försvinner ett steg eller ett krav blir CI bara grönare,
// utan att något annat märker det, så kopplingen låses här.
describe('GitHub Actions', () => {
  const workflow = (name) =>
    parseYaml(readFileSync(join(REPO, '.github/workflows', name), 'utf8'));
  const test = workflow('test.yml');
  const ci = workflow('ci.yml');
  const deploy = workflow('deploy.yml');
  // Ett steg som finns men inte kan fälla bygget skyddar inget.
  const expectCanFail = (step) => {
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.if).toBeUndefined();
    expect(step.run).not.toMatch(/\|\|\s*(true|:)|--exit-code|--baseline-path|--log-opts/);
  };

  it('kör hooktesterna i testjobbet och låter dem fälla bygget', () => {
    const step = test.jobs.tests.steps.find(
      ({ run }) => run === 'pnpm exec vitest run .claude/hooks',
    );
    expect(step).toBeDefined();
    expectCanFail(step);
  });

  it('kör test.yml både på pull requests och före deploy', () => {
    expect(ci.jobs.test.uses).toBe('./.github/workflows/test.yml');
    expect(ci.on).toHaveProperty('pull_request');
    expect(deploy.jobs.test.uses).toBe('./.github/workflows/test.yml');
    for (const job of ['build-and-push', 'deploy-frontend']) {
      expect(deploy.jobs[job].needs, job).toContain('test');
    }
  });

  it('låter ci-ok kräva varje annat jobb, även när ett av dem fallerat', () => {
    const { 'ci-ok': gate, ...others } = ci.jobs;
    expect([...gate.needs].sort()).toEqual(Object.keys(others).sort());
    expect(gate.if).toBe('always()');
    const check = gate.steps.map((step) => step.run).join('\n');
    for (const result of ['failure', 'cancelled', 'skipped']) expect(check).toContain(result);
  });

  it('skannar hela historiken med en versionslåst gitleaks vars kontrollsumma verifieras', () => {
    const { steps } = test.jobs.static;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkout.with['fetch-depth']).toBe(0);
    const scan = steps.find((step) => /gitleaks/i.test(step.name ?? ''));
    expectCanFail(scan);
    expect(scan.env.GITLEAKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(scan.env.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const verified = scan.run.indexOf('sha256sum --check --strict');
    expect(verified).toBeGreaterThan(-1);
    expect(scan.run.indexOf('tar -xzf')).toBeGreaterThan(verified);
    expect(scan.run.indexOf('gitleaks" detect')).toBeGreaterThan(verified);
    expect(scan.run).toContain('--config .gitleaks.toml');
  });
});

describe('CLAUDE.md', () => {
  it('importerar bara filer som finns', () => {
    const text = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');
    const imports = [...text.matchAll(/^@(\S+)$/gm)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const path of imports) {
      expect(existsSync(join(REPO, path)), path).toBe(true);
    }
  });
});

/** Frontmatter och text för en agent- eller skillfil. Claude Code ignorerar okända fält tyst. */
function markdownWithFrontmatter(path) {
  const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(
    readFileSync(join(REPO, path), 'utf8'),
  );
  return { meta: parseYaml(frontmatter), body };
}
const list = (value) => (Array.isArray(value) ? value : String(value).split(/,\s*/));
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Agent'];

describe('reviewer-agenten', () => {
  const { meta, body } = markdownWithFrontmatter('.claude/agents/reviewer.md');

  it('kan inte ändra filer eller starta andra agenter', () => {
    expect(meta.name).toBe('reviewer');
    expect(meta.permissionMode).toBe('plan');
    expect(list(meta.tools).filter((tool) => WRITE_TOOLS.includes(tool))).toEqual([]);
    expect(list(meta.disallowedTools)).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it('svarar med vad som granskats, vad som inte granskats, testläget och fynden', () => {
    for (const heading of ['## Granskat', '## Inte granskat', '## Tester', '## Fynd']) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('Bara ci-ok i GitHub avgör');
    expect(body).toContain('Du kör inga tester själv');
  });
});

describe('skills', () => {
  it('/review körs av reviewer-agenten i en egen kontext', () => {
    const { meta } = markdownWithFrontmatter('.claude/skills/review/SKILL.md');
    expect(meta).toMatchObject({ name: 'review', context: 'fork', agent: 'reviewer' });
  });

  it.each(['review', 'verify', 'phase'])(
    '/%s förhandsgodkänner varje kommando den kör när den laddas',
    (skill) => {
      const { meta, body } = markdownWithFrontmatter(`.claude/skills/${skill}/SKILL.md`);
      const allowed = [
        ...String(meta['allowed-tools'] ?? '').matchAll(/Bash\(([^)]+)\)/g),
      ].map((match) => match[1]);
      // Ett !`kommando` som inte är förhandsgodkänt avbryter hela skillen.
      for (const [, command] of body.matchAll(/!`([^`]+)`/g)) {
        expect(allowed, command).toContain(command);
      }
    },
  );

  it('/verify tillåter bara verifieringsskriptet och säger att bara användaren nollställer taket', () => {
    const { meta, body } = markdownWithFrontmatter('.claude/skills/verify/SKILL.md');
    expect(meta['allowed-tools']).toBe(
      'Bash(node .claude/hooks/verify.mjs) Bash(node .claude/hooks/verify.mjs --scope full)',
    );
    expect(body).toContain('Bara användaren');
    expect(body).toContain('ci-ok');
  });
});
