/**
 * Stegen som `verify.mjs` kör, samma kontroller som `.github/workflows/test.yml`, och hur ett stegs
 * utfall klassas. Ändras CI-stegen ska de ses över här också.
 *
 * Fallgrop: ett miljöfel (Docker nere, disken full) är inte ett testfel. Det klassas som `env_error`
 * så att ingen försöker "laga" ett test som aldrig fick köra.
 */

const MINUTE = 60_000;

export const STEPS = [
  { name: 'lint', command: ['pnpm', 'lint'], kind: 'static', timeoutMs: 10 * MINUTE },
  {
    name: 'boundaries',
    command: ['node', 'scripts/verify-boundaries-enforcement.mjs'],
    kind: 'static',
    timeoutMs: 5 * MINUTE,
    when: /^(services|shared|apps)\/|^eslint\.config\.js$/,
  },
  {
    name: 'secret-namespaces',
    command: ['node', 'scripts/verify-secret-namespaces.mjs'],
    kind: 'static',
    timeoutMs: 2 * MINUTE,
    when: /^infra\/k8s\//,
  },
  {
    name: 'typecheck',
    command: ['pnpm', 'typecheck'],
    kind: 'static',
    timeoutMs: 10 * MINUTE,
  },
  { name: 'unit', command: ['pnpm', 'test'], kind: 'test', timeoutMs: 15 * MINUTE },
  {
    name: 'claude-hooks',
    command: ['pnpm', 'exec', 'vitest', 'run', '.claude/hooks'],
    kind: 'test',
    timeoutMs: 5 * MINUTE,
  },
  {
    name: 'cdn-worker',
    command: ['pnpm', 'exec', 'vitest', 'run', 'infra/terraform/workers'],
    kind: 'test',
    timeoutMs: 5 * MINUTE,
    when: /^infra\/terraform\/workers\//,
  },
  {
    name: 'integration',
    command: ['pnpm', 'test:integration'],
    kind: 'test',
    docker: true,
    timeoutMs: 25 * MINUTE,
    when: /^(services|shared)\//,
  },
  {
    name: 'contract',
    command: ['pnpm', 'test:contract'],
    kind: 'test',
    docker: true,
    timeoutMs: 15 * MINUTE,
    when: /^(apps\/(web|scanner)|services|shared\/(schemas|rabbit|redis|types))\//,
  },
];

/** Körs bara i CI (kräver Auth0-testkonton och hela stacken). Står med i posten så att det syns. */
export const CI_ONLY = [
  { name: 'e2e', reason: 'Körs bara i CI (e2e.yml): kräver Auth0-testkonton.' },
];

const ENV_ERROR_OUTPUT = [
  /Cannot connect to the Docker daemon/i,
  /Could not find a working container runtime strategy/i,
  /docker\.sock/i,
  /Is the docker daemon running/i,
  /ENOSPC/,
  /spawn \S+ ENOENT/,
  /Timed out (while )?waiting for container/i,
];

/** Vilka steg som krävs för de ändrade sökvägarna. `full` kräver alla. */
export function planSteps(changedPaths, scope) {
  return STEPS.map((step) => {
    if (scope === 'full' || step.when === undefined) {
      return {
        ...step,
        required: true,
        reason: scope === 'full' ? 'scope full' : 'körs alltid',
      };
    }
    const match = changedPaths.find((path) => step.when.test(path));
    return match === undefined
      ? { ...step, required: false, reason: 'inga ändrade filer som berör steget' }
      : { ...step, required: true, reason: `ändrad: ${match}` };
  });
}

/** Utfallet för ett steg som körts: `passed`, `static_failure`, `test_failure`, `env_error` eller `timeout`. */
export function classify(step, { status, timedOut, output }) {
  if (timedOut) return 'timeout';
  if (status === 0) return 'passed';
  if (ENV_ERROR_OUTPUT.some((pattern) => pattern.test(output))) return 'env_error';
  return step.kind === 'static' ? 'static_failure' : 'test_failure';
}

/** Namnen på fallerande tester ur Vitest-utdata (högst tio), för att se om samma fel kommer igen. */
export function failingTests(output) {
  const names = output
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((line) => /^(FAIL|×)\s/.test(line))
    .map((line) => line.replace(/\s+\d+ms$/, '').slice(0, 200));
  return [...new Set(names)].slice(0, 10);
}

/**
 * Hela körningens resultat. `passed` bara om varje krävt steg gick igenom. Ett testfel väger tyngre än
 * ett miljöfel, och ett steg som inte kördes alls gör körningen `incomplete`.
 */
export function overallResult(steps) {
  const required = steps.filter((step) => step.required);
  if (required.every((step) => step.outcome === 'passed')) return 'passed';
  if (required.some((step) => ['static_failure', 'test_failure'].includes(step.outcome)))
    return 'failed';
  if (required.some((step) => ['env_error', 'timeout'].includes(step.outcome)))
    return 'env_error';
  return 'incomplete';
}
