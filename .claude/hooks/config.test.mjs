/**
 * Kontrollerar Claude Code-konfigurationens form (ADR-0012). Claude Code själv ignorerar en ogiltig
 * settings-fil tyst i `-p`-läge, och `claude doctor` validerar inte projektets inställningar. Då
 * försvinner alla neka-regler utan att någon märker det, så formen kontrolleras här i stället.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));
const { allow, ask, deny } = settings.permissions;

const KNOWN_TOP_LEVEL_KEYS = new Set(['$schema', 'permissions', 'env', 'hooks']);
const RULE_SHAPE = /^(Bash|Read|Edit|WebFetch|Agent|Skill)(\(.+\))?$/;
// Kommandon som kan köra godtycklig kod och därmed ta sig förbi neka-reglerna.
const WRAPPERS =
  /^Bash\((node|python3?|sh|bash|zsh|npx|pnpm (exec|dlx)|pnpm --filter|env|eval|xargs)\b/;

describe('.claude/settings.json', () => {
  it('har bara nycklar som projektet använder', () => {
    expect(Object.keys(settings).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key))).toEqual([]);
  });

  it('stänger av bypass- och auto-läget', () => {
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.permissions.disableAutoMode).toBe('disable');
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
    expect(allow.filter((rule) => WRAPPERS.test(rule))).toEqual([]);
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
