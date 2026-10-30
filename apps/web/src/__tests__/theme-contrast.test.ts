/**
 * Kontrasttest för temat `tikknet` (docs/plan.md 7.11): läser färgerna ur
 * shared/ui-theme/theme.css, räknar WCAG-kontrast från OKLCH och failar under 4,5 (text)
 * respektive 3 (grafik).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME_CSS = readFileSync(
  resolve(import.meta.dirname, '../../../../shared/ui-theme/theme.css'),
  'utf8',
);

function readColor(token: string): readonly [number, number, number] {
  const match = new RegExp(
    `--color-${token}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`,
  ).exec(THEME_CSS);
  if (match === null) {
    throw new Error(`Färgen --color-${token} saknas i theme.css`);
  }
  return [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
}

function toLinearSrgb([l, c, h]: readonly [number, number, number]): number[] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

function luminance(token: string): number {
  const [r = 0, g = 0, b = 0] = toLinearSrgb(readColor(token));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

// `success` klarar bara 3:1 (grafik, som planen anger), varken vit eller svart text når 4,5 på den.
// Därför läggs aldrig text på grön bakgrund: Badge och Alert använder en prick/kant i grönt.
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['base-content', 'base-100'],
  ['base-content', 'base-200'],
  ['muted', 'base-100'],
  ['muted', 'base-200'],
  ['primary-content', 'primary'],
  ['primary', 'base-100'],
  ['accent-content', 'accent'],
  ['accent', 'base-100'],
  ['neutral-content', 'neutral'],
  ['secondary-content', 'secondary'],
  ['warning-content', 'warning'],
  ['error-content', 'error'],
  ['info-content', 'info'],
  ['error', 'base-100'],
];

const GRAPHIC_PAIRS: readonly (readonly [string, string])[] = [
  ['success', 'base-100'],
  ['warning', 'base-100'],
  ['accent', 'base-200'],
  ['muted', 'base-300'],
];

describe('temat tikknet', () => {
  it.each(TEXT_PAIRS)('%s mot %s når 4,5:1 (text)', (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GRAPHIC_PAIRS)('%s mot %s når 3:1 (grafik)', (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
  });
});
