/**
 * Tillgänglighetskontroll med vitest-axe. Jämför `violations` direkt i stället för att
 * registrera axe-matchern (vitest-axes typer följer inte vitest 5). jsdom saknar layout, så
 * färgkontrasten kontrolleras i theme-contrast.test.ts och i e2e (`@axe-core/playwright`).
 */
import { expect } from 'vitest';
import { axe } from 'vitest-axe';

export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual(
    [],
  );
}
