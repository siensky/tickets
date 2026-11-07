/**
 * Kontrollerar Claude Code-konfigurationens form (ADR-0012). Claude Code själv ignorerar en ogiltig
 * settings-fil tyst i `-p`-läge, och `claude doctor` validerar inte projektets inställningar. Då
 * försvinner alla neka-regler utan att någon märker det, så formen kontrolleras här i stället.
 */
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
    expect(allow.filter((rule) => WRAPPERS.test(rule) && !VERIFY_COMMANDS.has(rule))).toEqual(
      [],
    );
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
      'pnpm test:integration',
      'pnpm test:contract',
    ]);
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
    const read = sandbox.filesystem.denyRead.join('\n');
    for (const path of ['.tikknet-tf.env', '/.ssh', '/.aws', '/.kube', 'infra/terraform'])
      expect(read, path).toContain(path);
    expect(sandbox.credentials.envVars.map((v) => v.mode)).not.toContain('allow');
  });

  it('frågar innan mallen ändras, eftersom användaren installerar den som root', () => {
    expect(ask).toContain('Edit(/.claude/managed-settings.example.json)');
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
