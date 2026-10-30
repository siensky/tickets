/**
 * Badge för kategori och säljstatus (docs/plan.md 7.11). Piller bara här och på chips.
 * `success` ligger på neutral yta med en grön prick: grönt klarar bara 3:1 (grafik), så text
 * läggs aldrig på grön bakgrund.
 */
import type { JSX, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'ghost';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'badge-neutral',
  primary: 'badge-primary',
  success: 'badge-ghost border-base-300',
  warning: 'badge-warning',
  error: 'badge-error',
  ghost: 'badge-ghost',
};

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`badge ${TONE_CLASS[tone]} rounded-full font-medium whitespace-nowrap`}>
      {tone === 'success' ? (
        <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}
